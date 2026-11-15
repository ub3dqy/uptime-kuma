const { readNotificationConfig } = require("../notification-config");
const { problem } = require("../projects/access");
const { log } = require("../../src/util");
const { TelegramControlBot } = require("./bot");
const { projectMonitors } = require("./monitors");
const { createTransport, readConfig, validBotToken } = require("./transport");

let bot;
let task;
let stopping = false;

/**
 * Read a single active Telegram channel from the authorized project.
 * @param {object} config Control bot settings, with an independently configured Telegram user ID
 * @param {object} scope Authorized project
 * @param {object} db Current connection or transaction
 * @returns {Promise<string>} Token from the saved notification settings
 */
async function tokenFromChannel(config, scope, db) {
    const query = db("notification")
        .where({ id: config.notificationId, user_id: scope.data_user_id, active: 1 })
        .first("user_id", "config");
    if (db.isTransaction) {
        query.forShare();
    }
    const row = await query;
    if (row) {
        const envelope = JSON.parse(row.config)?.projectEncryption;
        const channel = readNotificationConfig(row);
        if (
            envelope?.projectID === scope.id &&
            channel?.type === "telegram" &&
            channel.managedDelivery === true &&
            channel.telegramServerUrl === "https://api.telegram.org" &&
            String(channel.telegramChatID) === String(config.telegramUserId) &&
            validBotToken(channel.telegramBotToken)
        ) {
            return channel.telegramBotToken;
        }
    }
    throw problem("telegramControlChannelChanged");
}

/**
 * Bind commands to the bot identity and to the selected saved channel.
 * @param {object} config Operator-provisioned control settings
 * @param {object} services Runtime monitor and maintenance synchronization
 * @param {Function} makeTransport Factory for requests to Telegram
 * @returns {object} Scoped monitor operations and Bot API client
 */
function controlConnection(config, services, makeTransport = createTransport) {
    if (config.notificationId === undefined) {
        return { operations: projectMonitors(config, services), call: makeTransport(config.token) };
    }
    const botID = String(config.botId);
    let token;
    const verifyChannel = async (scope, db) => {
        const savedToken = await tokenFromChannel(config, scope, db);
        // Allow credential rotation for the selected bot, with a fresh authorization on each command.
        if (savedToken.split(":", 1)[0] !== botID) {
            throw problem("telegramControlChannelChanged");
        }
        token = savedToken;
    };
    const operations = projectMonitors(config, services, verifyChannel);
    let currentRequest;
    let requestToken;
    const call = async (method, data, signal) => {
        await operations.authorize();
        signal?.throwIfAborted();
        if (requestToken !== token || !currentRequest) {
            const nextToken = token;
            const request = makeTransport(nextToken);
            const webhook = await request("getWebhookInfo", {}, signal);
            if (webhook?.url !== "") {
                const error = new Error("Telegram control requires an available update stream");
                error.status = 409;
                throw error;
            }
            currentRequest = request;
            requestToken = nextToken;
        }
        return currentRequest(method, data, signal);
    };
    return { operations, call };
}

/**
 * Start only on installations with explicitly provisioned control settings.
 * @param {object} services Runtime synchronization after a committed change
 * @returns {void}
 */
function start(services) {
    const file = process.env.UPTIME_KUMA_TELEGRAM_CONTROL_CONFIG;
    if (!file || task || stopping) {
        return;
    }
    task = (async () => {
        try {
            const config = readConfig(file);
            const { operations, call } = controlConnection(config, services);
            bot = new TelegramControlBot(config, operations, call, (level, message) => {
                log[level]("telegram-control", message);
            });
            await bot.run();
        } catch {
            log.error("telegram-control", "Telegram control could not start. Check its configuration and relay.");
        }
    })();
}

/**
 * @returns {Promise<void>} Finish any in-flight database work before closing the server
 */
async function stop() {
    stopping = true;
    bot?.stop();
    await task;
}

module.exports = { start, stop, controlConnection };
