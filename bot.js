const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");
const cron = require("node-cron");
const {
    getDataFromSheet,
    appendDataToSheet,
    getNextFreeRow,
    getUserGoals,
    updateUserGoals,
    getUserRowIndex,
    formatDateForKiev,
    updateDataInSheet,
    checkUserExists,
    unloadDataToAll,
} = require("./sheets");

const ADMIN_USER_ID = 239415373;

const bot = new TelegramBot(config.botToken, { polling: true });
let registeredUsers = {};
let reminderTasks = {};
let awaitingComment = {};

// Очистка кэша при перезапуске бота
bot.on("polling_error", (error) => {
    console.error(`Polling error: ${error.message}`);
    registeredUsers = {};
    reminderTasks = {};
});

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.chat.first_name;
    const userId = chatId.toString();

    try {
        const userExists = await checkUserExists(
            config.spreadsheetId,
            userId,
            firstName
        );

        if (userExists) {
            bot.sendMessage(
                chatId,
                `Пользователь ${userId} с именем ${firstName} уже существует!`
            );
            sendWelcomeMessage(chatId, firstName);
            sendWelcomeButtons(chatId, firstName);
        } else {
            // Находим следующую свободную строку
            const nextFreeRow = await getNextFreeRow(
                config.spreadsheetId,
                "Sheet1"
            );

            // Записываем данные пользователя в следующую свободную строку
            await appendDataToSheet(
                config.spreadsheetId,
                `Sheet1!A${nextFreeRow}:B${nextFreeRow}`,
                [userId, firstName]
            );

            // Регистрируем пользователя в кэш
            registeredUsers[chatId] = true;

            // Отправляем приветственное сообщение и кнопки
            sendWelcomeMessage(chatId, firstName);
            sendWelcomeButtons(chatId, firstName);
        }
    } catch (error) {
        console.error(`Ошибка при регистрации пользователя: ${error}`);
        bot.sendMessage(
            chatId,
            "Произошла ошибка при регистрации. Пожалуйста, попробуйте позже."
        );
    }
});

// Обработчик команды /clear_cache
bot.onText(/\/clear_cache/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (userId === ADMIN_USER_ID) {
        registeredUsers = {};
        reminderTasks = {};
        bot.sendMessage(chatId, "Кэш успешно очищен.");
    } else {
        bot.sendMessage(chatId, "У вас нет прав для выполнения этой команды.");
    }
});

// Функция для включения напоминаний
const enableReminder = async (chatId, reminderType, bot, reminderTasks) => {
    const reminderMap = {
        enable_daily_reminder: {
            schedule: "30 6,16 * * 1-5", // 9:30 AM и 4:00 PM по Киевскому времени (UTC+3) с понедельника по пятницу
            message: "Твои цели на день 👇🤘✌️ ",
            goalsCallback: "daily_goals",
            reminderMessage: "Ежедневное напоминание включено.",
        },
        enable_weekly_reminder: {
            schedule: "35 6 * * 1", // 9:35 AM по Киевскому времени (UTC+3) каждый понедельник
            message: "Твои цели на неделю 👇🤘✌️ ",
            goalsCallback: "weekly_goals",
            reminderMessage: "Еженедельное напоминание включено.",
        },
        enable_monthly_reminder: {
            schedule: "40 6 1-7 * *", // 9:40 AM по Киевскому времени (UTC+3) в первый понедельник каждого месяца
            message: "Твои цели на месяц 👇🤘✌️ ",
            goalsCallback: "monthly_goals",
            reminderMessage: "Ежемесячное напоминание включено.",
        },
    };

    if (reminderMap[reminderType]) {
        const reminder = reminderMap[reminderType];

        try {
            // Устанавливаем задачу по расписанию
            const task = cron.schedule(reminder.schedule, async () => {
                try {
                    const goals = await getUserGoals(
                        config.spreadsheetId,
                        chatId,
                        reminder.goalsCallback
                    );
                    const formattedGoals = goals
                        .map((goal, index) => `${index + 1}. ${goal}`)
                        .join("\n");
                    bot.sendMessage(
                        chatId,
                        `${reminder.message}:\n\n${formattedGoals}`
                    );
                } catch (error) {
                    console.error(`Ошибка при обработке данных: ${error}`);
                    bot.sendMessage(
                        chatId,
                        "Произошла ошибка при обработке данных. Пожалуйста, попробуйте позже."
                    );
                }
            });

            // Сохраняем задачу
            reminderTasks[chatId] = reminderTasks[chatId] || {};
            reminderTasks[chatId][reminderType] = task;

            // Отправляем сообщение с кнопкой "Комментарии"
            bot.sendMessage(chatId, reminder.reminderMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Комментарии",
                                callback_data: "add_comment",
                            },
                        ],
                    ],
                },
            });

            return task;
        } catch (error) {
            console.error(`Ошибка при установке напоминания: ${error}`);
            bot.sendMessage(
                chatId,
                "Произошла ошибка при установке напоминания. Пожалуйста, попробуйте позже."
            );
            return null;
        }
    } else {
        console.error(`Неверный тип напоминания: ${reminderType}`);
        bot.sendMessage(
            chatId,
            "Неверный тип напоминания. Пожалуйста, попробуйте еще раз."
        );
        return null;
    }
};

// Функция для отключения напоминаний
const disableReminder = (chatId, reminderType) => {
    if (reminderTasks[chatId] && reminderTasks[chatId][reminderType]) {
        reminderTasks[chatId][reminderType].stop();
        delete reminderTasks[chatId][reminderType];
        bot.sendMessage(chatId, "Напоминание отключено.");
    } else {
        bot.sendMessage(
            chatId,
            "У вас нет активных напоминаний для этого типа."
        );
    }
};

// Функция для обработки добавления комментариев
const handleAddComment = async (chatId, goalType) => {
    bot.sendMessage(chatId, "Введите ваш комментарий:");
    awaitingComment[chatId] = goalType;

    bot.once("message", async (msg) => {
        const comment = msg.text;
        const goalType = awaitingComment[chatId];

        if (!goalType) {
            bot.sendMessage(
                chatId,
                "Произошла ошибка. Пожалуйста, попробуйте еще раз."
            );
            return;
        }

        try {
            const currentGoals =
                (
                    await getUserGoals(config.spreadsheetId, chatId, goalType)
                )[0] || "";
            const now = new Date().toISOString();
            const kievDateTime = formatDateForKiev(now);

            await updateUserGoals(
                config.spreadsheetId,
                chatId,
                goalType,
                currentGoals,
                comment
            );

            const commentColumnMap = {
                daily_goals: `L${await getUserRowIndex(
                    config.spreadsheetId,
                    chatId
                )}`,
                weekly_goals: `M${await getUserRowIndex(
                    config.spreadsheetId,
                    chatId
                )}`,
                monthly_goals: `N${await getUserRowIndex(
                    config.spreadsheetId,
                    chatId
                )}`,
            };
            await updateDataInSheet(
                config.spreadsheetId,
                commentColumnMap[goalType],
                [kievDateTime]
            );

            bot.sendMessage(
                chatId,
                `Ваш комментарий для целей на ${goalType} сохранен.`
            );
        } catch (error) {
            console.error(`Ошибка при сохранении комментария: ${error}`);
            bot.sendMessage(
                chatId,
                "Произошла ошибка при сохранении комментария. Пожалуйста, попробуйте позже."
            );
        } finally {
            delete awaitingComment[chatId];
        }
    });
};

const sendWelcomeMessage = (chatId, firstName) => {
    bot.sendMessage(chatId, `Приветствую, ${firstName} 👌!`);
};

const sendWelcomeButtons = (chatId, firstName) => {
    bot.sendMessage(chatId, `Выберите тип целей: ✏️✍️`, {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "Цели на день ",
                        callback_data: "daily_goals",
                    },
                    {
                        text: "Цели на неделю ",
                        callback_data: "weekly_goals",
                    },
                    {
                        text: "Цели на месяц ",
                        callback_data: "monthly_goals",
                    },
                ],
            ],
        },
    });
};

// Обработчик callback_query
bot.on("callback_query", async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    switch (data) {
        case "daily_goals":
            const dailyGoals = await getUserGoals(
                config.spreadsheetId,
                chatId,
                "daily_goals"
            );
            const dailyGoalsMessage = `Твои цели на день ✅:\n\n${dailyGoals
                .map((goal, index) => `${index + 1}. ${goal}`)
                .join("\n")}`;
            bot.sendMessage(chatId, dailyGoalsMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Включить напоминание",
                                callback_data: "enable_daily_reminder",
                            },
                            {
                                text: "Добавить комментарий",
                                callback_data: "add_comment",
                            },
                        ],
                    ],
                },
            });
            break;
        case "weekly_goals":
            const weeklyGoals = await getUserGoals(
                config.spreadsheetId,
                chatId,
                "weekly_goals"
            );
            const weeklyGoalsMessage = `Твои цели на неделю ✅:\n\n${weeklyGoals
                .map((goal, index) => `${index + 1}. ${goal}`)
                .join("\n")}`;
            bot.sendMessage(chatId, weeklyGoalsMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Включить напоминание",
                                callback_data: "enable_weekly_reminder",
                            },
                            {
                                text: "Добавить комментарий",
                                callback_data: "add_comment",
                            },
                        ],
                    ],
                },
            });
            break;
        case "monthly_goals":
            const monthlyGoals = await getUserGoals(
                config.spreadsheetId,
                chatId,
                "monthly_goals"
            );
            const monthlyGoalsMessage = `Твои цели на месяц ✅:\n\n${monthlyGoals
                .map((goal, index) => `${index + 1}. ${goal}`)
                .join("\n")}`;
            bot.sendMessage(chatId, monthlyGoalsMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Включить напоминание",
                                callback_data: "enable_monthly_reminder",
                            },
                            {
                                text: "Добавить комментарий",
                                callback_data: "add_comment",
                            },
                        ],
                    ],
                },
            });
            break;
        case "enable_daily_reminder":
            enableReminder(chatId, "enable_daily_reminder", bot, reminderTasks);
            break;
        case "enable_weekly_reminder":
            enableReminder(
                chatId,
                "enable_weekly_reminder",
                bot,
                reminderTasks
            );
            break;
        case "enable_monthly_reminder":
            enableReminder(
                chatId,
                "enable_monthly_reminder",
                bot,
                reminderTasks
            );
            break;
        case "add_comment":
            bot.sendMessage(chatId, "Выберите тип комментария:", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "День",
                                callback_data: "comment_daily",
                            },
                            {
                                text: "Неделя",
                                callback_data: "comment_weekly",
                            },
                            {
                                text: "Месяц",
                                callback_data: "comment_monthly",
                            },
                        ],
                    ],
                },
            });
            break;
        case "comment_daily":
            await handleAddComment(chatId, "daily_goals");
            break;
        case "comment_weekly":
            await handleAddComment(chatId, "weekly_goals");
            break;
        case "comment_monthly":
            await handleAddComment(chatId, "monthly_goals");
            break;
        default:
            break;
    }

    bot.answerCallbackQuery(callbackQuery.id);
});

// Обработчик для непонятных текстовых сообщений
bot.on("message", (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (awaitingComment[chatId]) {
        // Если бот ожидает комментарий, то обработка комментария будет происходить в handleAddComment
        return;
    }

    if (!text.startsWith("/")) {
        bot.sendMessage(chatId, "Ой-ой-ой, я не знаю такой команды 🤷‍♀️🤷‍♀️🤷‍♀️");
    }
});

bot.onText(/\/unload/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (userId === ADMIN_USER_ID) {
        try {
            // Вызвать функцию для выгрузки данных из Sheet1 в all
            await unloadDataToAll(config.spreadsheetId);
            bot.sendMessage(chatId, "Данные успешно выгружены в лист all.");
        } catch (error) {
            console.error(`Ошибка при выгрузке данных: ${error}`);
            bot.sendMessage(chatId, "Произошла ошибка при выгрузке данных.");
        }
    } else {
        bot.sendMessage(chatId, "У вас нет прав для выполнения этой команды.");
    }
});
