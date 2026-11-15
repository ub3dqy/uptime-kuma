const { R } = require("redbean-node");
const { randomUUID } = require("node:crypto");
const { identifier, managedAlertConfig, channelSettings } = require("./managed-alert-config");
const { serviceHost, issueExplanation, currentServiceState } = require("../src/overview-state.ts");
const { readNotificationConfig, protectNotificationConfig } = require("./notification-config");
const { workFromBeat } = require("../src/site-work.ts");

const openStates = ["queued", "sending"];

/**
 * Only retry errors that establish rejection or failure before submission.
 * A timeout after sending may mean delivery: never blindly repeat it.
 * @param {object} error Untrusted transport error
 * @returns {{code:string,retry:boolean,uncertain:boolean,delay:number}} Safe classification
 */
function deliveryFailure(error) {
    const code = error?.originalCode || error?.code;
    const status = error?.response?.status;
    const smtpStatus = Number(error?.responseCode);
    if (status === 429) {
        const seconds = Number(error?.response?.data?.parameters?.retry_after);
        const waitSeconds = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 30;
        return {
            code: "rate",
            retry: waitSeconds <= 604800,
            uncertain: false,
            delay: Math.min(604800, Math.max(30, waitSeconds)) * 1000,
        };
    }
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code) || (smtpStatus >= 400 && smtpStatus < 500)) {
        return { code: "unavailable", retry: true, uncertain: false, delay: 30000 };
    }
    if (code === "EAUTH" || status === 401 || status === 403 || smtpStatus === 535) {
        return { code: "auth", retry: false, uncertain: false, delay: 0 };
    }
    if (/CERT|TLS|SSL/.test(String(code))) {
        return { code: "tls", retry: false, uncertain: false, delay: 0 };
    }
    if (status === 400 || (smtpStatus >= 500 && smtpStatus < 600)) {
        return { code: "recipient", retry: false, uncertain: false, delay: 0 };
    }
    return { code: "unknown", retry: false, uncertain: true, delay: 0 };
}

/**
 * A small durable queue: one in-flight delivery, bounded transport timeouts and attempts.
 * Configurations are loaded at execution, not copied with secrets into job records.
 */
class DeliveryQueue {
    /**
     * @param {object} options Isolated database, clock and transport overrides for verification
     */
    constructor(options = {}) {
        this.options = options;
        this.timer = null;
        this.running = null;
        this.stopped = false;
    }
    /** @returns {object} The current database connection, including after a reconnect */
    get db() {
        return this.options.db || R.knex;
    }
    /** @returns {number} Current UTC milliseconds */
    now() {
        return this.options.now ? this.options.now() : Date.now();
    }
    /** @returns {Promise<void>} Recover interrupted sends conservatively and start polling */
    async start() {
        await this.db("notification_delivery").where({ status: "sending" }).update({
            status: "uncertain",
            error_code: "interrupted",
            updated_at: this.now(),
        });
        this.stopped = false;
        this.timer = setInterval(() => this.tick(), 2000);
        this.timer.unref();
    }
    /** @returns {Promise<void>} Stop claiming work and await the bounded current transport */
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        await this.running;
    }
    /** @returns {Promise<void>} At most one delivery attempt */
    async tick() {
        if (this.running || this.stopped) {
            return;
        }
        this.running = this.processOne().catch(() => {
            // Transport errors and URLs can contain credentials: log no raw error objects.
            this.options.onError?.("notificationQueueUnavailable");
        });
        try {
            await this.running;
        } finally {
            this.running = null;
        }
    }
    /** @returns {Promise<void>} Atomically claim, reauthorize and submit one queued job */
    async processOne() {
        await this.db("notification_delivery")
            .where({ status: "sending" })
            .where("updated_at", "<", this.now() - 120000)
            .update({ status: "uncertain", error_code: "interrupted", updated_at: this.now() });
        const job = await this.db("notification_delivery")
            .where({ status: "queued" })
            .where("next_attempt_at", "<=", this.now())
            .orderBy("id")
            .first();
        if (!job) {
            return;
        }
        const claimed = await this.db("notification_delivery")
            .where({ id: job.id, status: "queued" })
            .update({ status: "sending", attempts: job.attempts + 1, updated_at: this.now() });
        if (!claimed) {
            return;
        }
        const finish = (status, errorCode = null, extra = {}) =>
            this.db("notification_delivery")
                .where({ id: job.id })
                .update({ status, error_code: errorCode, updated_at: this.now(), ...extra });
        const channel = await this.db("notification").where({ id: job.notification_id, user_id: job.user_id }).first();
        if (!channel || channel.delivery_revision !== job.revision) {
            await finish("cancelled", "changed");
            return;
        }
        const rateBlock = await this.db("notification_delivery")
            .where({ notification_id: job.notification_id, error_code: "rate" })
            .where("next_attempt_at", ">", this.now())
            .orderBy("next_attempt_at", "desc")
            .first();
        if (rateBlock) {
            await finish("queued", "rate", { attempts: job.attempts, next_attempt_at: rateBlock.next_attempt_at });
            return;
        }
        if (job.kind !== "test") {
            const monitor =
                job.monitor_id &&
                (await this.db("monitor").where({ id: job.monitor_id, user_id: job.user_id }).first());
            const assigned =
                monitor &&
                (await this.db("monitor_notification")
                    .where({ monitor_id: job.monitor_id, notification_id: job.notification_id })
                    .first());
            if (!assigned || !(await activeMonitor(this.db, monitor, job.user_id))) {
                await finish("cancelled", "changed");
                return;
            }
            const maintenance =
                this.options.isUnderMaintenance || ((id) => require("./model/monitor").isUnderMaintenance(id));
            if (job.kind !== "work" && (await maintenance(job.monitor_id))) {
                await finish("cancelled", "maintenance");
                return;
            }
            if (["down", "up", "work"].includes(job.kind)) {
                const latest = await this.db("heartbeat")
                    .where({ monitor_id: job.monitor_id })
                    .orderBy("time", "desc")
                    .first();
                const expected = job.kind === "work" ? "maintenance" : job.kind;
                const signal = job.kind === "work"
                    ? await (this.options.siteWork || require("./site-work").signalForMonitor)(monitor, this.now())
                    : null;
                if (!latest || currentServiceState(monitor, [latest], this.now()).state !== expected ||
                    (job.kind === "work" && (signal?.state !== "active" || signal.work.runID !== workFromBeat(latest)?.runID ||
                        job.event_key !== `site-work:${job.monitor_id}:${signal.work.runID}`))) {
                    await finish("cancelled", "changed");
                    return;
                }
            }
        }
        // Recheck after asynchronous ownership/maintenance reads, immediately before transport.
        const current = await this.db("notification")
            .where({ id: channel.id, user_id: job.user_id, delivery_revision: job.revision })
            .first();
        if (!current) {
            await finish("cancelled", "changed");
            return;
        }
        try {
            const config = managedAlertConfig(readNotificationConfig(current));
            const envelope = JSON.parse(current.config).projectEncryption;
            const validActor = async () => {
                if (job.kind !== "test" || !envelope) {
                    return true;
                }
                try {
                    const actor = await this.db("project_delivery_actor")
                        .where({ delivery_id: job.id, project_id: envelope.projectID })
                        .first();
                    if (!actor?.user_id) {
                        return false;
                    }
                    const scope = await require("./projects/access").permit(
                        actor.user_id,
                        actor.project_id,
                        "admin",
                        this.db
                    );
                    return scope.data_user_id === job.user_id && scope.revision === actor.project_revision;
                } catch {
                    return false;
                }
            };
            if (!(await validActor())) {
                await finish("cancelled", "changed");
                return;
            }
            if (envelope && config.type === "smtp") {
                const policy = await require("./projects/network-policy").policyForProject(envelope.projectID);
                const originalHost = config.smtpHost;
                try {
                    [config.smtpHost] = await policy.addresses(originalHost);
                } catch (error) {
                    if (error.message === "PROJECT_TARGET_BLOCKED") {
                        await finish("failed", "target");
                        return;
                    }
                    throw error;
                }
                if (!require("node:net").isIP(originalHost)) {
                    config.smtpServerName = originalHost;
                }
            }
            const stillCurrent = await this.db("notification")
                .where({ id: channel.id, user_id: job.user_id, delivery_revision: job.revision })
                .first();
            if (!stillCurrent || !(await validActor())) {
                await finish("cancelled", "changed");
                return;
            }
            const send =
                this.options.send ||
                ((settings, message) => require("./notification").Notification.send(settings, message));
            await send(config, job.payload);
            await finish("submitted");
        } catch (error) {
            const failure = deliveryFailure(error);
            const retry = failure.retry && job.attempts + 1 < 3;
            await finish(retry ? "queued" : failure.uncertain ? "uncertain" : "failed", failure.code, {
                next_attempt_at: this.now() + failure.delay * (job.attempts + 1),
            });
        }
    }
    /**
     * @param {number} userID Owner
     * @param {number} notificationID Saved channel
     * @param {string} kind Message purpose
     * @param {string} payload Sanitized message
     * @param {string} eventKey Stable event identity
     * @param {number|null} monitorID Related owned check
     * @param {number|null} revision Expected settings revision
     * @param {Function} guard Optional live authorization guard for user actions
     * @param {object|null} projectActor Human initiating a protected project test
     * @returns {Promise<number>} Existing or newly persisted delivery
     */
    async enqueue(
        userID,
        notificationID,
        kind,
        payload,
        eventKey,
        monitorID = null,
        revision = null,
        guard = () => {},
        projectActor = null
    ) {
        identifier(userID);
        identifier(notificationID);
        if (
            !["test", "up", "down", "work", "certificate", "domain"].includes(kind) ||
            typeof payload !== "string" ||
            payload.length > 4000 ||
            typeof eventKey !== "string" ||
            eventKey.length > 160
        ) {
            throw new Error("stage2InvalidRequest");
        }
        return this.db.transaction(async (tx) => {
            await guard(tx);
            const channel = await tx("notification").where({ id: notificationID, user_id: userID }).first();
            if (!channel || readNotificationConfig(channel).managedDelivery !== true) {
                throw new Error("stage2ChannelNotFound");
            }
            if (revision !== null && channel.delivery_revision !== revision) {
                throw new Error("stage2ChannelChanged");
            }
            const envelope = JSON.parse(channel.config).projectEncryption;
            let testScope;
            if (kind === "test" && envelope) {
                if (projectActor && projectActor.projectID !== envelope.projectID) {
                    throw new Error("stage2InvalidRequest");
                }
                testScope = await require("./projects/access").permit(
                    projectActor?.userID ?? userID,
                    envelope.projectID,
                    "admin",
                    tx
                );
                if (testScope.data_user_id !== userID) {
                    throw new Error("stage2InvalidRequest");
                }
            }
            const duplicate = await tx("notification_delivery")
                .where({ notification_id: notificationID, event_key: eventKey })
                .first();
            if (duplicate) {
                return duplicate.id;
            }
            const count = await tx("notification_delivery")
                .where({ user_id: userID })
                .whereIn("status", openStates)
                .count({ n: "id" })
                .first();
            const total = await tx("notification_delivery").whereIn("status", openStates).count({ n: "id" }).first();
            if (Number(count.n) >= 100 || Number(total.n) >= 1000) {
                throw new Error("stage2QueueFull");
            }
            if (kind === "test") {
                const rateBlock = await tx("notification_delivery")
                    .where({ notification_id: notificationID, error_code: "rate" })
                    .where("next_attempt_at", ">", this.now())
                    .first();
                if (rateBlock) {
                    throw new Error("stage2ProviderCooldown");
                }
                const recent = await tx("notification_delivery")
                    .where({ notification_id: notificationID, kind: "test" })
                    .where("created_at", ">", this.now() - 30000)
                    .first();
                if (recent) {
                    throw new Error("stage2TestCooldown");
                }
            }
            const [id] = await tx("notification_delivery").insert({
                user_id: userID,
                notification_id: notificationID,
                monitor_id: monitorID,
                revision: channel.delivery_revision,
                kind,
                payload,
                event_key: eventKey,
                status: "queued",
                attempts: 0,
                created_at: this.now(),
                updated_at: this.now(),
                next_attempt_at: this.now(),
            });
            if (testScope) {
                await tx("project_delivery_actor").insert({
                    delivery_id: id,
                    project_id: testScope.id,
                    user_id: testScope.actor_id,
                    project_revision: testScope.revision,
                });
            }
            await guard(tx);
            return id;
        });
    }
}

const queue = new DeliveryQueue({ onError: (code) => require("../src/util").log.error("notification", code) });

/**
 * Respect paused ancestors without trusting a client-only forceInactive flag.
 * @param {object} db Current database connection
 * @param {object|null} monitor Owned check
 * @param {number} userID Job owner
 * @returns {Promise<boolean>} All retained ancestors are owned and active
 */
async function activeMonitor(db, monitor, userID) {
    const visited = new Set();
    for (let current = monitor; current && visited.size < 50;) {
        if (!current.active || current.user_id !== userID || visited.has(current.id)) {
            return false;
        }
        visited.add(current.id);
        if (!current.parent) {
            return true;
        }
        current = await db("monitor").where({ id: current.parent, user_id: userID }).first();
    }
    return false;
}

/**
 * Save a channel and its selected owner-owned checks atomically, with a revision check.
 * @param {number} userID Authenticated owner
 * @param {object} request Untrusted form
 * @param {Function} guard Recheck live authorization before commit
 * @param {number|null} projectID Explicitly scoped project
 * @returns {Promise<number>} Channel identifier
 */
async function saveManagedChannel(userID, request, guard = () => {}, projectID = null) {
    if (!request || !Array.isArray(request.monitorIDs) || request.monitorIDs.length > 200) {
        throw new Error("stage2InvalidRequest");
    }
    const ids = [...new Set(request.monitorIDs.map(identifier))];
    return R.knex.transaction(async (tx) => {
        await guard(tx);
        const id = request.id == null ? null : identifier(request.id);
        const current = id && (await tx("notification").where({ id, user_id: userID }).first());
        if (id && (!current || current.delivery_revision !== request.revision)) {
            throw new Error("stage2ChannelChanged");
        }
        const owned = ids.length
            ? await tx("monitor").where({ user_id: userID }).whereIn("id", ids).whereNot("type", "group").select("id")
            : [];
        if (owned.length !== ids.length) {
            throw new Error("stage2InvalidRequest");
        }
        const config = managedAlertConfig(request.config, current && readNotificationConfig(current));
        const values = {
            user_id: userID,
            name: config.name,
            config: JSON.stringify(await protectNotificationConfig(config, userID, current?.config, tx, projectID)),
            is_default: config.isDefault ? 1 : 0,
            delivery_revision: current ? current.delivery_revision + 1 : 1,
        };
        let savedID = id;
        if (current) {
            const changed = await tx("notification")
                .where({ id, user_id: userID, delivery_revision: request.revision })
                .update(values);
            if (!changed) {
                throw new Error("stage2ChannelChanged");
            }
        } else {
            [savedID] = await tx("notification").insert(values);
        }
        await tx("monitor_notification").where({ notification_id: savedID }).delete();
        if (ids.length) {
            await tx("monitor_notification").insert(
                ids.map((monitorID) => ({ monitor_id: monitorID, notification_id: savedID }))
            );
        }
        await tx("notification_delivery")
            .where({ notification_id: savedID, status: "queued" })
            .update({ status: "cancelled", error_code: "changed", updated_at: Date.now() });
        await guard(tx);
        return savedID;
    });
}

/**
 * Delete the exact saved channel revision and its relations in one authorized transaction.
 * @param {number} userID Authenticated owner
 * @param {object} request Channel identifier and revision
 * @param {Function} guard Live authorization guard
 * @returns {Promise<void>} Deleted channel
 */
async function deleteManagedChannel(userID, request, guard = () => {}) {
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const channel = await tx("notification")
            .where({ id: identifier(request?.id), user_id: userID, delivery_revision: request.revision })
            .first();
        if (!channel || readNotificationConfig(channel).managedDelivery !== true) {
            throw new Error("stage2ChannelChanged");
        }
        await tx("monitor_notification").where({ notification_id: channel.id }).delete();
        const removed = await tx("notification")
            .where({ id: channel.id, user_id: userID, delivery_revision: request.revision })
            .delete();
        if (!removed) {
            throw new Error("stage2ChannelChanged");
        }
        await guard(tx);
    });
}

/**
 * Read bounded channel/delivery information without returning provider credentials or messages.
 * @param {number} userID Authenticated owner
 * @param {number|null} monitorID Optional owned check
 * @returns {Promise<object>} Settings and delivery facts
 */
async function deliveryOverview(userID, monitorID = null) {
    if (
        monitorID !== null &&
        !(await R.knex("monitor")
            .where({ id: identifier(monitorID), user_id: userID })
            .first())
    ) {
        throw new Error("stage2InvalidRequest");
    }
    const rows = await R.knex("notification").where({ user_id: userID }).orderBy("id");
    const relations = rows.length
        ? await R.knex("monitor_notification")
              .whereIn(
                  "notification_id",
                  rows.map((row) => row.id)
              )
              .select("monitor_id", "notification_id")
        : [];
    const jobs = R.knex("notification_delivery").where({ user_id: userID }).orderBy("id", "desc").limit(100);
    if (monitorID !== null) {
        jobs.where({ monitor_id: monitorID });
    }
    const deliveries = (await jobs).map(({ payload, event_key: eventKey, ...row }) => row);
    const channels = rows
        .map((row) => {
            let config = {};
            try {
                config = readNotificationConfig(row) || {};
            } catch {
                /* Keep a broken old channel from hiding every other channel. */
            }
            return {
                id: row.id,
                name: row.name,
                revision: row.delivery_revision,
                type: config.type,
                managed: config.managedDelivery === true,
                isDefault: row.is_default === 1,
                settings: config.managedDelivery ? channelSettings(config) : {},
                hasSecret: Boolean(config.smtpPassword || config.telegramBotToken),
                monitorIDs: relations.filter((link) => link.notification_id === row.id).map((link) => link.monitor_id),
            };
        })
        .filter((row) => monitorID === null || row.monitorIDs.includes(monitorID));
    return { channels, deliveries };
}

/**
 * The administrator confirms receipt only after a submitted test of the current settings.
 * @param {number} userID Authenticated owner
 * @param {number} deliveryID Test record
 * @param {Function} guard Live authorization guard
 * @returns {Promise<void>}
 */
async function confirmReceipt(userID, deliveryID, guard = () => {}) {
    await R.knex.transaction(async (tx) => {
        const job = await tx("notification_delivery")
            .where({ id: identifier(deliveryID), user_id: userID, kind: "test", status: "submitted" })
            .first();
        const channel =
            job &&
            (await tx("notification")
                .where({ id: job.notification_id, user_id: userID, delivery_revision: job.revision })
                .first());
        if (!channel) {
            throw new Error("stage2ConfirmationInvalid");
        }
        await guard(tx);
        await tx("notification_delivery").where({ id: job.id, user_id: userID }).update({ confirmed_at: Date.now() });
        await guard(tx);
    });
}

/**
 * Compose a minimal owner-requested message; remote errors and signed paths are excluded.
 * @param {object} monitor Owned check
 * @param {object} beat Saved observation
 * @param {string} locale Channel language
 * @param {string} primaryBaseURL Administrator-configured application address
 * @param {number|null} projectID Protected channel's project
 * @param {object|null} workContext Trusted work transition
 * @returns {string} Safe text
 */
function monitorMessage(monitor, beat, locale = "en", primaryBaseURL = "", projectID = null, workContext = null) {
    const name = String(monitor.name || "Service")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 120);
    const host = serviceHost(monitor);
    let state =
        beat.status === 1
            ? locale === "ru"
                ? "Работа восстановлена"
                : "Service restored"
            : locale === "ru"
              ? "Подтверждён сбой"
              : "Failure confirmed";
    const messages = locale === "ru" ? require("../src/lang/ru-RU.json") : require("../src/lang/en.json");
    const work = workContext?.work;
    let workDetails = "";
    if (workContext && require("../src/site-work.ts").validatedWork(work)) {
        const event = ["started", "finished", "overdue", "signal_lost"].includes(workContext.event) ? workContext.event : "signal_lost";
        let status = "down";
        if (beat.status === 1) status = "up";
        else if (beat.status === 2) status = "pending";
        state = messages[`siteWorkNotice_${event}_${status}`];
        workDetails = [messages[`siteWorkName_${work.kind}`], messages[`siteWorkPhase_${work.phase}`],
            (locale === "ru" ? "Предельный срок (UTC): " : "Deadline (UTC): ") + new Date(work.deadline).toISOString()].join(". ");
    }
    const reason = messages[issueExplanation("down", beat.msg)] || messages.workspaceIssueUnreachable;
    let link = "";
    try {
        const base = new URL(primaryBaseURL);
        if (["http:", "https:"].includes(base.protocol) && !base.username && !base.password) {
            const target =
                projectID === null
                    ? `/dashboard/${identifier(monitor.id)}`
                    : `/projects/${identifier(projectID)}?check=${identifier(monitor.id)}`;
            link = base.origin + target;
        }
    } catch {
        // Never guess a public address or include credentials from a malformed setting.
    }
    return [state + ": " + name, host, "UTC: " + beat.time, workDetails, beat.status === 0 ? reason : "", link]
        .filter(Boolean)
        .join("\n");
}

/**
 * Enqueue a test of already saved settings. This does not certify inbox receipt.
 * @param {number} userID Authenticated owner
 * @param {object} request Channel/revision identifiers
 * @param {Function} guard Live authorization guard
 * @param {object|null} projectActor Initiating human for a project-owned channel
 * @returns {Promise<number>} Durable test record
 */
async function requestTest(userID, request, guard = () => {}, projectActor = null) {
    const channel = await R.knex("notification")
        .where({ id: identifier(request?.id), user_id: userID, delivery_revision: request.revision })
        .first();
    if (!channel) {
        throw new Error("stage2ChannelChanged");
    }
    const config = readNotificationConfig(channel);
    const message =
        config.locale === "ru"
            ? "Проверка оповещений Uptime Kuma. Если сообщение пришло, подтвердите получение в настройках канала."
            : "Uptime Kuma notification test. Confirm receipt in channel settings only if you received this message.";
    return queue.enqueue(
        userID,
        channel.id,
        "test",
        message,
        `test:${randomUUID()}`,
        null,
        request.revision,
        guard,
        projectActor
    );
}

module.exports = {
    DeliveryQueue,
    queue,
    deliveryFailure,
    saveManagedChannel,
    deleteManagedChannel,
    deliveryOverview,
    confirmReceipt,
    monitorMessage,
    requestTest,
};
