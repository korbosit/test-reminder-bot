// logger.js
const fs = require("fs");
const path = require("path");

const logFile = path.join(__dirname, "bot.log");
const errorFile = path.join(__dirname, "errors.log");

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;
    fs.appendFileSync(logFile, logMessage);
}

function logError(error) {
    const timestamp = new Date().toISOString();
    const errorMessage = `${timestamp} - ${error.stack || error}\n`;
    fs.appendFileSync(errorFile, errorMessage);
}

module.exports = {
    log,
    logError,
};
