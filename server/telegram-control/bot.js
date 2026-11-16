const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const menu = require("./menu");
const strings = require("../../src/lang/ru-RU.json");

const approvalLifetime = 120000;
const searchLifetime = 600000;
const pollRecovery = 6 * 86400000;
const messageLimit = 4096;
const botErrors = {
    projectAccessDenied: "Этот монитор или действие недоступны.",
    projectChanged: "Данные изменились. Откройте монитор заново.",
    telegramSearchExpired: "Поиск устарел. Введите название снова.",
    telegramParentPaused: "Сначала возобновите проверки родительской группы в панели.",
    telegramMaintenanceUnavailable: "Техработы можно начать для активного монитора без действующего окна.",
    periodSummaryTooLarge: "За сутки слишком много записей для сводки в чате. В панели можно выбрать меньший период.",
    projectAINotConnected: strings.projectAINotConnected,
    projectAINeedProbe: strings.projectAINeedProbe,
    projectAIDailyLimit: strings.projectAIDailyLimit,
    projectAIBusy: strings.projectAIBusy,
    projectAIEvidenceChanged: "Появились новые данные. Откройте диагностику и проверьте их перед отправкой.",
    telegramAICancelUnavailable: "Этот запрос уже завершился или недоступен для отмены.",
    telegramAIPreviewTooLarge: "Данные не помещаются в сообщение. Откройте диагностику в панели.",
};

class TelegramControlBot {
    /**
     * @param {object} config Bound Telegram identity
     * @param {object} operations Project monitor operations
     * @param {Function} call Telegram request function
     * @param {Function} log Fixed-message operational logger
     */
    constructor(config, operations, call, log) {
        this.user = config.telegramUserId;
        this.operations = operations;
        this.call = call;
        this.log = log;
        this.abort = new AbortController();
        this.approval = null;
        this.search = null;
        this.offset = 0;
        this.lastUpdateAt = 0;
        this.retryUntil = 0;
    }

    /**
     * @returns {Promise<void>} Poll until stopped, with bounded backoff
     */
    async run() {
        const signal = this.abort.signal;
        let retry = 1000;
        let unavailable = false;
        while (!signal.aborted) {
            try {
                const wait = this.retryUntil - Date.now();
                if (wait > 0) {
                    await delay(wait, undefined, { signal });
                }
                if (Date.now() - this.lastUpdateAt > pollRecovery) {
                    this.offset = 0;
                }
                const updates = await this.request("getUpdates", {
                    offset: this.offset,
                    timeout: 20,
                    limit: 10,
                    allowed_updates: ["message", "callback_query"],
                });
                if (!Array.isArray(updates)) {
                    throw new Error("Invalid Telegram response");
                }
                if (unavailable) {
                    this.log("info", "Telegram control connection restored.");
                }
                unavailable = false;
                retry = 1000;
                for (const update of updates) {
                    if (signal.aborted || Date.now() < this.retryUntil) {
                        break;
                    }
                    if (
                        !Number.isSafeInteger(update?.update_id) ||
                        update.update_id < this.offset ||
                        update.update_id >= Number.MAX_SAFE_INTEGER
                    ) {
                        continue;
                    }
                    this.offset = update.update_id + 1;
                    this.lastUpdateAt = Date.now();
                    await this.handle(update);
                }
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                if (!unavailable) {
                    const hints = {
                        409: " Check for another poller or a configured webhook.",
                        telegramControlChannelChanged: " Check the saved Telegram channel and configured recipient.",
                        projectAccessDenied: " Check the project membership and required sign-in.",
                        projectKeyMissing: " Check the encrypted notification settings.",
                    };
                    const key = error.status ?? error.message;
                    const reason = Object.hasOwn(hints, key) ? hints[key] : "";
                    this.log("warn", "Telegram control could not receive updates." + reason);
                    unavailable = true;
                }
                this.retryUntil = Math.max(this.retryUntil, Date.now() + retry);
                retry = Math.min(retry * 2, 60000);
            }
        }
    }

    /**
     * @returns {void} Stop pending Telegram requests and invalidate confirmations
     */
    stop() {
        this.abort.abort();
        this.approval = null;
        this.search = null;
    }

    /**
     * @param {string} method Fixed Bot API method
     * @param {object} data Request fields
     * @returns {Promise<unknown>} Telegram result
     */
    async request(method, data) {
        try {
            return await this.call(method, data, this.abort.signal);
        } catch (error) {
            if (error.status === 429) {
                this.retryUntil = Math.max(this.retryUntil, Date.now() + (error.retryAfter || 1000));
            }
            throw error;
        }
    }

    /**
     * @param {object} from Telegram author
     * @param {object} chat Telegram conversation
     * @returns {boolean} Only the provisioned human in their own private chat
     */
    allowed(from, chat) {
        return from?.id === this.user && from.is_bot === false && chat?.type === "private" && chat.id === this.user;
    }

    /**
     * @param {object} update Telegram message or callback
     * @returns {Promise<void>} Handle the owner's interaction
     */
    async handle(update) {
        const callback = update.callback_query;
        const message = callback?.message ?? update.message;
        if (!this.allowed(callback?.from ?? message?.from, message?.chat) || this.abort.signal.aborted) {
            return;
        }
        if (
            typeof callback?.data === "string" &&
            /^alert:[a-zA-Z0-9_-]{22}$/.test(callback.data) &&
            typeof callback.id === "string" &&
            callback.id.length <= 128
        ) {
            let accepted = false;
            try {
                accepted = await this.operations.acknowledgeAlert?.(callback.data.slice(6));
            } catch {
                // Retain the button so a temporary access or connection problem can be retried.
            }
            try {
                await this.request("answerCallbackQuery", {
                    callback_query_id: callback.id,
                    text: accepted
                        ? "Принято"
                        : "Оповещение недоступно для подтверждения",
                });
                if (accepted) {
                    await this.request("editMessageReplyMarkup", {
                        chat_id: this.user,
                        message_id: message.message_id,
                        reply_markup: { inline_keyboard: [] },
                    });
                }
            } catch {
                // The confirmation is durable even if Telegram cannot update an older message.
            }
            return;
        }
        // Telegram shows a spinner until acknowledged. A stale query must not prevent a reply.
        if (callback && typeof callback.id === "string" && callback.id.length <= 128) {
            try {
                await this.request("answerCallbackQuery", { callback_query_id: callback.id });
            } catch (error) {
                if (error.status === 429 || this.abort.signal.aborted) {
                    return;
                }
            }
        }
        let result;
        try {
            result = callback ? await this.callback(callback, message) : await this.message(message.text);
        } catch (error) {
            result = menu.reply(
                [
                    Object.hasOwn(botErrors, error.message)
                        ? botErrors[error.message]
                        : "Действие не удалось. Проверьте состояние в панели.",
                ],
                [[menu.home()]]
            );
        }
        if (!result || this.abort.signal.aborted) {
            return;
        }
        try {
            await this.show(result, callback ? message.message_id : null);
        } catch (error) {
            if (!this.abort.signal.aborted && error.status !== 429) {
                this.log("warn", "Telegram control could not show a reply.");
            }
        }
    }

    /**
     * @param {object} result Menu text and inline keyboard
     * @param {number|null} messageId Message to refresh
     * @returns {Promise<void>} Send or update menu
     */
    async show(result, messageId) {
        const { approval, ...body } = result;
        const confirmation = approval && this.approval?.key === approval;
        if (messageId && !confirmation) {
            try {
                await this.request("editMessageText", {
                    chat_id: this.user,
                    message_id: messageId,
                    text: body.text,
                    reply_markup: body.reply_markup,
                    link_preview_options: body.link_preview_options,
                });
                return;
            } catch (error) {
                if (error.status !== 400) {
                    throw error;
                }
                if (error.unchanged) {
                    return;
                }
            }
        }
        const sent = await this.request("sendMessage", { chat_id: this.user, ...body });
        if (confirmation && this.approval?.key === approval && Number.isSafeInteger(sent?.message_id)) {
            this.approval.messageId = sent.message_id;
        }
    }

    /**
     * @param {unknown} text Private message text
     * @returns {Promise<object|undefined>} Menu, search results or usage
     */
    async message(text) {
        if (typeof text !== "string" || text.length > 200) {
            return;
        }
        text = text.trim();
        const [command, ...words] = text.split(/\s+/);
        switch (command.toLowerCase()) {
            case "/start":
            case "/menu":
            case "/status":
                return this.callback({ data: "home" });
            case "/monitors":
                return this.callback({ data: "list:all:0" });
            case "/down":
                return this.callback({ data: "list:down:0" });
            case "/certs":
                return this.callback({ data: "cert:0" });
            case "/maintenance":
                return this.callback({ data: "windows" });
            case "/notifications":
                return this.callback({ data: "deliveries" });
            case "/journal":
                return this.callback({ data: "journal" });
            case "/ai":
                return this.callback({ data: "ai" });
            case "/find":
                return words.length ? this.find(words.join(" ")) : this.callback({ data: "search" });
            case "/cancel":
                this.approval = null;
                this.search = null;
                return menu.reply(["Действие отменено."], [[menu.home()]]);
            case "/help":
                return menu.reply(
                    [
                        "/status — сводка",
                        "/monitors — список",
                        "/down — подтверждённые сбои",
                        "/find название — поиск",
                        "/certs — сертификаты",
                        "/maintenance — техработы из Telegram",
                        "/notifications — отправки",
                        "/journal — действия",
                        "/ai — диагностика ИИ",
                        "/cancel — отмена",
                    ],
                    [[menu.home()]]
                );
            default:
                if (text && !text.startsWith("/") && this.search?.expires > Date.now()) {
                    return this.find(text);
                }
                return menu.reply(["Откройте меню или отправьте /help."], [[menu.home()]]);
        }
    }

    /**
     * @param {string} text Requested monitor name
     * @returns {Promise<object>} First search results page
     */
    async find(text) {
        const query = text.slice(0, 100);
        this.search = { query, key: randomBytes(8).toString("hex"), expires: Date.now() + searchLifetime };
        return this.callback({ data: `found:${this.search.key}:0` });
    }

    /**
     * @param {object} callback Closed navigation or confirmation
     * @param {object} message Message that displayed the button
     * @returns {Promise<object|undefined>} Menu response
     */
    async callback(callback, message) {
        if (typeof callback.data !== "string" || Buffer.byteLength(callback.data) > 64) {
            return;
        }
        const [route, first, second, third, ...extra] = callback.data.split(":");
        const id = Number(first);
        const page = Number(second);
        const isPage = (value) => Number.isSafeInteger(value) && value >= 0;
        const isID = (value) => isPage(value) && value > 0;
        if (!extra.length) {
            switch (route) {
                case "home":
                    this.search = null;
                    return menu.summary(await this.operations.list());
                case "list":
                    if (["all", "issues", "down", "paused", "maintenance"].includes(first) && isPage(page) && !third) {
                        const titles = {
                            all: "Мониторы",
                            issues: "Мониторы с проблемами",
                            down: "Подтверждённые сбои",
                            paused: "Мониторы на паузе",
                            maintenance: "Мониторы на техработах",
                        };
                        return menu.monitors(
                            await this.operations.list(first, page),
                            titles[first],
                            (next) => `list:${first}:${next}`
                        );
                    }
                    break;
                case "cert":
                    if (isPage(id)) {
                        return menu.certificates(await this.operations.certificates(id));
                    }
                    break;
                case "deliveries":
                    return menu.deliveries(await this.operations.deliveries());
                case "windows":
                    return menu.windows(await this.operations.windows());
                case "journal":
                    return menu.journal(await this.operations.journal());
                case "search":
                    await this.operations.authorize();
                    this.search = { expires: Date.now() + searchLifetime };
                    return menu.reply(["Пришлите часть названия монитора."], [[menu.home()]]);
                case "found":
                    if (
                        this.search?.query &&
                        this.search.key === first &&
                        this.search.expires > Date.now() &&
                        isPage(page)
                    ) {
                        return menu.monitors(
                            await this.operations.list("all", page, this.search.query),
                            `Поиск · ${menu.label(this.search.query)}`,
                            (next) => `found:${first}:${next}`
                        );
                    }
                    throw new Error("telegramSearchExpired");
                case "monitor":
                    if (isID(id)) {
                        return menu.detail(await this.operations.detail(id));
                    }
                    break;
                case "history":
                    if (isID(id)) {
                        return menu.history(await this.operations.detail(id));
                    }
                    break;
                case "report":
                    if (isID(id)) {
                        return menu.report(await this.operations.report(id), id);
                    }
                    break;
                case "ai":
                    if (first === undefined) {
                        return menu.aiOverview(await this.operations.ai.overview());
                    }
                    break;
                case "ai-check":
                case "ai-job":
                case "ai-prepare":
                case "ai-stop":
                    if (!isID(id) || String(id) !== first || second !== undefined) {
                        break;
                    }
                    if (route === "ai-check") {
                        return menu.aiOverview(await this.operations.ai.overview(id));
                    }
                    if (route === "ai-job") {
                        return menu.aiJob(await this.operations.ai.job(id));
                    }
                    return this.confirmation(
                        await (route === "ai-prepare"
                            ? this.operations.ai.prepare(id)
                            : this.operations.ai.prepareCancel(id))
                    );
                case "durations":
                    if (isID(id)) {
                        const monitor = await this.operations.detail(id);
                        if (
                            monitor.canControl &&
                            monitor.active &&
                            !monitor.parentPaused &&
                            !monitor.window &&
                            monitor.state !== "maintenance"
                        ) {
                            return menu.durationMenu(monitor);
                        }
                    }
                    break;
                case "prepare":
                    if (
                        isID(page) &&
                        ((["pause", "resume"].includes(first) && third === undefined) ||
                            (["maintenance", "end"].includes(first) && isID(Number(third))))
                    ) {
                        const request = await this.operations.prepare(
                            first,
                            page,
                            third === undefined ? undefined : Number(third)
                        );
                        return this.confirmation(request);
                    }
                    break;
                case "yes":
                case "no":
                    if (second === undefined) {
                        return this.confirm(route, first, message?.message_id);
                    }
                    break;
            }
        }
        return menu.reply(["Откройте меню и выберите действие снова."], [[menu.home()]]);
    }

    /**
     * @param {object} request Prepared change or diagnosis
     * @returns {object} Single-use confirmation bound to the displayed message
     * @throws {Error} If Telegram cannot display the full preview
     */
    confirmation(request) {
        const key = randomBytes(16).toString("hex");
        const screen = menu.confirmation(request, key);
        if (request.action === "aiDiagnosis" && screen.text.length > messageLimit) {
            throw new Error("telegramAIPreviewTooLarge");
        }
        this.approval = { key, expires: Date.now() + approvalLifetime, request };
        return { ...screen, approval: key };
    }

    /**
     * @param {string} route Confirm or cancel
     * @param {string} key One-time approval key
     * @param {number} messageId Message bound to the key
     * @returns {Promise<object>} Outcome of consuming the confirmation
     */
    async confirm(route, key, messageId) {
        const approval = this.approval;
        if (
            this.abort.signal.aborted ||
            !approval ||
            !messageId ||
            approval.key !== key ||
            approval.expires <= Date.now() ||
            approval.messageId !== messageId
        ) {
            return menu.reply(["Подтверждение устарело. Выберите действие снова."], [[menu.home()]]);
        }
        this.approval = null;
        if (route === "no") {
            return menu.reply(["Действие отменено."], [[menu.home()]]);
        }
        if (approval.request.action === "aiDiagnosis") {
            return menu.aiChanged(await this.operations.ai.enqueue(approval.request), false);
        }
        if (approval.request.action === "aiCancel") {
            await this.operations.ai.cancel(approval.request);
            return menu.aiChanged(approval.request.argument, true);
        }
        const result = await this.operations.apply(approval.request);
        if (result.syncFailed) {
            this.log("error", "Telegram control saved a change that could not be synchronized with monitoring.");
        }
        return menu.changed(result);
    }
}

module.exports = { TelegramControlBot };
