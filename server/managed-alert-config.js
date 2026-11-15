/**
 * Validate a positive database identifier without accepting coercion or SQL fragments.
 * @param {unknown} value Untrusted identifier
 * @returns {number} Identifier
 * @throws {Error} Invalid identifier
 */
function identifier(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("stage2InvalidRequest");
    }
    return value;
}

/**
 * Bounded text for a channel form; never allow injected mail headers.
 * @param {unknown} value Form value
 * @param {number} max Maximum length
 * @param {boolean} required Whether empty values are allowed
 * @returns {string} Trimmed text
 * @throws {Error} Invalid text
 */
function text(value, max = 254, required = true) {
    if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error("stage2ChannelInvalid");
    }
    const result = value.trim();
    if (required && !result) {
        throw new Error("stage2ChannelInvalid");
    }
    return result;
}

/**
 * The guided workflow only enables encrypted SMTP or the official Telegram service.
 * Missing secrets are preserved on edits and never returned by the channel DTO.
 * @param {object} input Untrusted configuration
 * @param {object|null} previous Current stored configuration
 * @returns {object} Allowlisted configuration
 * @throws {Error} Invalid channel settings
 */
function managedAlertConfig(input, previous = null) {
    if (!input || !["smtp", "telegram"].includes(input.type)) {
        throw new Error("stage2ChannelInvalid");
    }
    const base = {
        name: text(input.name, 120),
        type: input.type,
        managedDelivery: true,
        isDefault: input.isDefault === true,
        applyExisting: false,
        locale: input.locale === "ru" || input.locale === "ru-RU" ? "ru" : "en",
    };
    if (input.type === "smtp") {
        const host = text(input.smtpHost, 253);
        if (!/^[a-z\d.:[\]_-]+$/i.test(host)) {
            throw new Error("stage2ChannelInvalid");
        }
        const port = input.smtpPort;
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
            throw new Error("stage2ChannelInvalid");
        }
        const from = text(input.smtpFrom);
        const to = text(input.smtpTo);
        if (![from, to].every((value) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))) {
            throw new Error("stage2ChannelInvalid");
        }
        let password = input.smtpPassword;
        if ((password === "" || password === undefined) && previous?.type === "smtp" && !input.clearSecret) {
            password = previous.smtpPassword || "";
        }
        if (
            typeof (password ?? "") !== "string" ||
            (password || "").length > 1024 ||
            String(password || "").includes("\0")
        ) {
            throw new Error("stage2ChannelInvalid");
        }
        return {
            ...base,
            smtpHost: host,
            smtpPort: port,
            smtpSecure: input.smtpSecure === true,
            smtpIgnoreTLSError: false,
            smtpIgnoreSTARTTLS: false,
            smtpRequireTLS: true,
            smtpUsername: text(input.smtpUsername || "", 254, false),
            smtpPassword: password || "",
            ...(input.smtpServerName ? { smtpServerName: text(input.smtpServerName, 253) } : {}),
            smtpFrom: from,
            smtpTo: to,
        };
    }
    let token = input.telegramBotToken;
    if ((token === "" || token === undefined) && previous?.type === "telegram" && !input.clearSecret) {
        token = previous.telegramBotToken;
    }
    token = text(token, 240);
    const chat = text(input.telegramChatID, 64);
    if (!/^\d{5,20}:[a-z\d_-]{20,200}$/i.test(token) || !/^(?:-?\d{1,20}|@[a-z][a-z\d_]{4,31})$/i.test(chat)) {
        throw new Error("stage2ChannelInvalid");
    }
    return { ...base, telegramBotToken: token, telegramChatID: chat, telegramServerUrl: "https://api.telegram.org" };
}

/**
 * Expose only fields needed for editing; passwords and bot tokens never enter this DTO.
 * @param {object} config Stored configuration
 * @returns {object} Public-to-owner settings
 */
function channelSettings(config) {
    const fields =
        config.type === "smtp"
            ? ["smtpHost", "smtpPort", "smtpSecure", "smtpUsername", "smtpFrom", "smtpTo"]
            : ["telegramChatID"];
    return Object.fromEntries(fields.map((key) => [key, config[key]]));
}

module.exports = { identifier, managedAlertConfig, channelSettings };
