const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const NotificationProvider = require("../notification-providers/notification-provider");

const maxConfigBytes = 4096;

/**
 * @param {unknown} token Telegram credential from the operator or the saved channel
 * @returns {boolean} Whether this can be safely used in the fixed Bot API URL
 */
function validBotToken(token) {
    return typeof token === "string" && /^\d{5,20}:[a-z\d_-]{20,200}$/i.test(token);
}

/**
 * Read the operator's private bot configuration.
 * @param {string} filename Absolute private file path
 * @returns {object} Validated bot identity and project scope
 * @throws {Error} Inaccessible or invalid configuration
 */
function readConfig(filename) {
    if (!path.isAbsolute(filename) || fs.lstatSync(filename).isSymbolicLink()) {
        throw new Error("Invalid Telegram control configuration");
    }
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    const fd = fs.openSync(filename, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
    let config;
    try {
        const stat = fs.fstatSync(fd);
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size > maxConfigBytes ||
            (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
        ) {
            throw new Error("Invalid Telegram control configuration");
        }
        const bytes = Buffer.alloc(maxConfigBytes + 1);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (length > maxConfigBytes) {
            throw new Error("Invalid Telegram control configuration");
        }
        config = JSON.parse(bytes.toString("utf8", 0, length));
    } finally {
        fs.closeSync(fd);
    }
    const positive = (value) => Number.isSafeInteger(value) && value > 0;
    const hasToken = Boolean(config && Object.hasOwn(config, "token"));
    const hasChannel = Boolean(config && Object.hasOwn(config, "notificationId"));
    if (
        config?.version !== 1 ||
        hasToken === hasChannel ||
        (hasToken && !validBotToken(config.token)) ||
        (hasChannel && (!positive(config.notificationId) || !positive(config.botId))) ||
        ![config.telegramUserId, config.userId, config.projectId].every(positive)
    ) {
        throw new Error("Invalid Telegram control configuration");
    }
    return {
        ...(hasToken ? { token: config.token } : { notificationId: config.notificationId, botId: config.botId }),
        telegramUserId: config.telegramUserId,
        userId: config.userId,
        projectId: config.projectId,
    };
}

/**
 * Use the fixed Telegram endpoint and the existing notification relay, if configured.
 * Raw HTTP errors can contain the token. Expose only safe error metadata.
 * @param {string} token Bot token
 * @param {object} http Axios-compatible client
 * @returns {Function} Bot API request function
 */
function createTransport(token, http = axios) {
    const options = new NotificationProvider().getAxiosConfigWithProxy({
        proxy: false,
        maxRedirects: 0,
        maxContentLength: 1048576,
        maxBodyLength: 16384,
        validateStatus: () => true,
    });
    return async (method, body, signal) => {
        let response;
        try {
            response = await http.post(`https://api.telegram.org/bot${token}/${method}`, body, {
                ...options,
                timeout: method === "getUpdates" ? 30000 : 5000,
                signal,
            });
        } catch {
            throw new Error("Telegram request failed");
        }
        if (response.status === 200 && response.data?.ok === true) {
            return response.data.result;
        }
        const error = new Error("Telegram request rejected");
        error.status = response.status;
        error.unchanged =
            method === "editMessageText" &&
            response.status === 400 &&
            typeof response.data?.description === "string" &&
            response.data.description.startsWith("Bad Request: message is not modified");
        const delay = response.data?.parameters?.retry_after;
        error.retryAfter = Number.isSafeInteger(delay) && delay > 0 ? Math.min(delay, 86400) * 1000 : 0;
        throw error;
    };
}

module.exports = { createTransport, readConfig, validBotToken };
