// logger.js
const fs = require("fs");
const path = require("path");

const logFile = path.join(__dirname, "bot.log");

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
}

module.exports = log;
