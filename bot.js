const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const logFile = path.join(__dirname, "bot.log");
const errorFile = path.join(__dirname, "errors.log");
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
    updateReminderStatus,
} = require("./sheets");

const { log, logError } = require("./logger");

const ADMIN_USER_ID = 239415373;

const bot = new TelegramBot(config.botToken, { polling: true });
let registeredUsers = {};
let reminderTasks = {};
let awaitingComment = {};

// Очистка кэша при перезапуске бота
bot.on("polling_error", (error) => {
    logError(`Polling error: ${error.message}`);
    registeredUsers = {};
    reminderTasks = {};
});

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.chat.first_name;
    const userId = chatId.toString();

    try {
        const userExists = await checkUserExists(config.spreadsheetId, userId);

        if (userExists) {
            await bot.sendMessage(
                chatId,
                `Пользователь c таким id ::: ${userId} ::: с именем ${firstName} уже существует!`
            );
            await sendWelcomeMessage(chatId, firstName);
            await sendWelcomeButtons(chatId, firstName);
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
            await sendWelcomeMessage(chatId, firstName);
            await sendWelcomeButtons(chatId, firstName);
        }
    } catch (error) {
        logError(`Ошибка при регистрации пользователя: ${error}`);
        await bot.sendMessage(
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
            schedule: "30 9,16 * * 1-5", // 9:30 AM и 4:00 PM по Киевскому времени (UTC+3) с понедельника по пятницу
            message: "Твои цели на день 👇🤘✌️ ",
            goalsCallback: "daily_goals",
            reminderMessage:
                "Ежедневные напоминания включены ✌️. Они будут приходить тебе каждый день в 🕘 9:30 утра и 16:00 по Киевскому времени в рабочие дни с понедельника по пятницу.",
        },
        enable_weekly_reminder: {
            schedule: "35 9 * * 1", // 9:35 AM по Киевскому времени (UTC+3) каждый понедельник
            message: "Твои цели на неделю 👇🤘✌️ ",
            goalsCallback: "weekly_goals",
            reminderMessage:
                "Еженедельные напоминания включены ✌️. Они будут приходить тебе каждый понедельник в 🕘 9:35 утра по Киевскому времени.",
        },
        enable_monthly_reminder: {
            schedule: "40 9 1 * 1", // 9:40 AM по Киевскому времени (UTC+3) в первый понедельник каждого месяца
            message: "Твои цели на месяц 👇🤘✌️ ",
            goalsCallback: "monthly_goals",
            reminderMessage:
                "Ежемесячные напоминания включены ✌️. Они будут приходить тебе в первый понедельник каждого месяца в 🕘 9:40 утра по Киевскому времени.",
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
                    logError(`Ошибка при обработке данных: ${error}`);
                    bot.sendMessage(
                        chatId,
                        "Произошла ошибка при обработке данных. Пожалуйста, попробуйте позже."
                    );
                }
            });

            // Сохраняем задачу
            reminderTasks[chatId] = reminderTasks[chatId] || {};
            reminderTasks[chatId][reminderType] = task;

            // Обновляем статус напоминания в таблице
            const userId = chatId.toString();
            await updateReminderStatus(
                config.spreadsheetId,
                userId,
                reminderType,
                "enable"
            );

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
            logError(`Ошибка при установке напоминания: ${error}`);
            bot.sendMessage(
                chatId,
                "Произошла ошибка при установке напоминания. Пожалуйста, попробуйте позже."
            );
            return null;
        }
    } else {
        logError(`Неверный тип напоминания: ${reminderType}`);
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
        reminderTasks[chatId][reminderType].stop(); // Остановка задачи
        delete reminderTasks[chatId][reminderType];
        bot.sendMessage(chatId, "Напоминание отключено.");
    } else {
        bot.sendMessage(
            chatId,
            "У вас нет активных напоминаний для этого типа."
        );
    }
};

// Обработчик команды /disable_daily_tasks
bot.onText(/\/disable_daily_tasks/, async (msg) => {
    const chatId = msg.chat.id;
    disableReminder(chatId, "enable_daily_reminder");
    const userId = chatId.toString();
    await updateReminderStatus(
        config.spreadsheetId,
        userId,
        "enable_daily_reminder",
        "disable"
    );
    bot.sendMessage(chatId, "Ежедневные напоминания отключены ✅");
});

// Обработчик команды /disable_weekly_tasks
bot.onText(/\/disable_weekly_tasks/, async (msg) => {
    const chatId = msg.chat.id;
    disableReminder(chatId, "enable_weekly_reminder");
    const userId = chatId.toString();
    await updateReminderStatus(
        config.spreadsheetId,
        userId,
        "enable_weekly_reminder",
        "disable"
    );
    bot.sendMessage(chatId, "Еженедельные напоминания отключены ✅");
});

// Обработчик команды /disable_monthly_tasks
bot.onText(/\/disable_monthly_tasks/, async (msg) => {
    const chatId = msg.chat.id;
    disableReminder(chatId, "enable_monthly_reminder");
    const userId = chatId.toString();
    await updateReminderStatus(
        config.spreadsheetId,
        userId,
        "enable_monthly_reminder",
        "disable"
    );
    bot.sendMessage(chatId, "Ежемесячные напоминания отключены ✅");
});

// Функция для обработки добавления комментариев
const handleAddComment = async (chatId, goalType) => {
    bot.sendMessage(chatId, "Введите ваш комментарий:");
    awaitingComment[chatId] = goalType;

    bot.once("message", async (msg) => {
        const comment = msg.text;
        const goalType = awaitingComment[chatId];
        const userId = msg.from.id.toString();
        const userName = msg.from.first_name;

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
                `Ваш комментарий для отчёта на ${goalType} сохранен.`
            );

            // Отправляем уведомление администратору
            const adminNotification = getAdminNotification(
                userName,
                userId,
                goalType,
                comment
            );
            bot.sendMessage(ADMIN_USER_ID, adminNotification);
        } catch (error) {
            logError(`Ошибка при сохранении комментария: ${error}`);
            bot.sendMessage(
                chatId,
                "Произошла ошибка при сохранении комментария. Пожалуйста, попробуйте позже."
            );
        } finally {
            delete awaitingComment[chatId];
        }
    });
};

// Функция для формирования уведомления администратору
const getAdminNotification = (userName, userId, goalType, comment) => {
    const goalTypeMap = {
        daily_goals: "день",
        weekly_goals: "неделю",
        monthly_goals: "месяц",
    };

    const goalTypePeriod = goalTypeMap[goalType];

    return `Пользователь с именем ${userName} и id ${userId} оставил комментарий для целей на ${goalTypePeriod} ✏️✍️:
    ==============================
    ${comment}`;
};

const sendWelcomeMessage = (chatId, firstName) => {
    return bot.sendMessage(
        chatId,
        `Приветствую тебя ${firstName} 👋
        У каждого сотрудника у нас в компании есть ряд задач которые иногда теряются в потоке рабочих процессов. Я здесь для того, что бы напоминать тебе о них ✅
        Как сейчас работают напоминания при включении:

        на день 2 раза в день:
        🕘9:30 утра и 16:00  по Киевскому времени с понедельника по пятницу

        на неделю 1 раз в неделю:
        🕓9:35 утра  по Киевскому времени  каждый понедельник

        на месяц 1 раз в неделю:
        🕙9:40 утра по Киевскому времени  в первый понедельник каждого месяца

        ‼️Ежедневно в конце рабочего дня или сразу после выполнения задачи тебе необходимо будет написать отчет по итогам каждой задачи из списка.
        `
    );
};

const sendWelcomeButtons = (chatId, firstName) => {
    return bot.sendMessage(chatId, `Выберите тип целей: ✏️✍️`, {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "Цели на день 👇👇👇 ",
                        callback_data: "daily_goals",
                    },
                    {
                        text: "Цели на неделю 👇👇👇",
                        callback_data: "weekly_goals",
                    },
                    {
                        text: "Цели на месяц 👇👇👇",
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
                                text: "Добавить отчёт",
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
            bot.sendMessage(chatId, "Выберите тип отчёта:", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Отчёт на день",
                                callback_data: "comment_daily",
                            },
                            {
                                text: "Отчёт на неделю",
                                callback_data: "comment_weekly",
                            },
                            {
                                text: "Отчёт на месяц",
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
            logError(`Ошибка при выгрузке данных: ${error}`);
            bot.sendMessage(chatId, "Произошла ошибка при выгрузке данных.");
        }
    } else {
        bot.sendMessage(chatId, "У вас нет прав для выполнения этой команды.");
    }
});

process.on("uncaughtException", (error) => {
    logError(`Необработанная ошибка: ${error.stack || error}`);
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    logError(`Необработанное отклонение промиса: ${reason.stack || reason}`);
});

// Задача для удаления старых логов (запускается еженедельно)
cron.schedule("0 0 * * 0", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    try {
        fs.readFile(logFile, "utf8", (err, data) => {
            if (err) {
                logError(`Ошибка при чтении файла логов: ${err}`);
                return;
            }

            const lines = data.split("\n").filter((line) => {
                const lineDate = new Date(line.split(" - ")[0]);
                return lineDate >= thirtyDaysAgo;
            });

            const updatedLog = lines.join("\n");

            fs.writeFile(logFile, updatedLog, (err) => {
                if (err) {
                    logError(`Ошибка при записи в файл логов: ${err}`);
                }
            });
        });

        fs.readFile(errorFile, "utf8", (err, data) => {
            if (err) {
                logError(`Ошибка при чтении файла ошибок: ${err}`);
                return;
            }

            const lines = data.split("\n").filter((line) => {
                const lineDate = new Date(line.split(" - ")[0]);
                return lineDate >= thirtyDaysAgo;
            });

            const updatedLog = lines.join("\n");

            fs.writeFile(errorFile, updatedLog, (err) => {
                if (err) {
                    logError(`Ошибка при записи в файл ошибок: ${err}`);
                }
            });
        });
    } catch (err) {
        logError(`Ошибка при удалении старых логов: ${err}`);
    }
});

// Обработчики ошибок и завершение процесса
process.on("uncaughtException", (error) => {
    logError(`Необработанная ошибка: ${error.stack || error}`);
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    logError(`Необработанное отклонение промиса: ${reason.stack || reason}`);
});
