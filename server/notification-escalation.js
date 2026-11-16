const { randomBytes, randomUUID } = require("node:crypto");
const { R } = require("redbean-node");
const { identifier } = require("./managed-alert-config");
const { readNotificationConfig } = require("./notification-config");
const { readConfig } = require("./telegram-control/transport");

const waitTime = 5 * 60_000;
const events = ["down", "up", "work"];
const tokenPattern = /^[a-zA-Z0-9_-]{22}$/;

/**
 * @param {object} row Channel with stored settings
 * @returns {number|null} Project that owns the channel
 */
function projectOf(row) {
    return JSON.parse(row.config)?.projectEncryption?.projectID ?? null;
}

/**
 * @param {object} telegram Saved and decrypted Telegram channel
 * @param {object} row Telegram record
 * @returns {boolean} The configured private bot can receive acknowledgement for this route
 */
function privateBot(telegram, row) {
    try {
        const binding = readConfig(process.env.UPTIME_KUMA_TELEGRAM_CONTROL_CONFIG);
        return (
            binding.notificationId === row.id &&
            binding.projectId === projectOf(row) &&
            String(binding.telegramUserId) === telegram.telegramChatID &&
            String(binding.botId) === telegram.telegramBotToken.split(":", 1)[0]
        );
    } catch {
        return false;
    }
}

/**
 * @param {object} db Current database connection
 * @param {object} rule Selected policy
 * @param {number} userID Data owner
 * @returns {Promise<object|null>} Current email route, if the saved channels and assignments match
 */
async function emailRoute(db, rule, userID) {
    const rows = await db("notification")
        .where({ user_id: userID, active: 1 })
        .whereIn("id", [rule.telegram_id, rule.email_id]);
    const primary = rows.find((row) => row.id === rule.telegram_id);
    const backup = rows.find((row) => row.id === rule.email_id);
    if (
        primary?.delivery_revision !== rule.telegram_revision ||
        backup?.delivery_revision !== rule.email_revision ||
        projectOf(primary) !== projectOf(backup)
    ) {
        return null;
    }
    const links = await db("monitor_notification")
        .where({ monitor_id: rule.monitor_id })
        .whereIn("notification_id", [primary.id, backup.id]);
    if (links.length !== 1 || links[0].notification_id !== primary.id) {
        return null;
    }
    try {
        const telegram = readNotificationConfig(primary);
        const email = readNotificationConfig(backup);
        return telegram?.type === "telegram" &&
            telegram.managedDelivery &&
            email?.type === "smtp" &&
            email.managedDelivery &&
            privateBot(telegram, primary)
            ? backup
            : null;
    } catch {
        return null;
    }
}

/**
 * @param {number} userID Data owner
 * @param {number|null} monitorID Optional selected monitor
 * @returns {Promise<object[]>} Editable rules, without channel secrets
 */
async function rulesForOwner(userID, monitorID = null) {
    const query = R.knex("monitor_alert_rule as a")
        .join("monitor as m", "a.monitor_id", "m.id")
        .where("m.user_id", userID);
    if (monitorID !== null) {
        query.where("a.monitor_id", identifier(monitorID));
    }
    return query.select("a.monitor_id as monitorID", "a.telegram_id as telegramID", "a.email_id as emailID");
}

/**
 * @param {number} userID Data owner
 * @param {object} request Monitor and channel IDs, or an explicitly disabled rule
 * @param {Function} guard Live administrator authorization
 * @param {number|null} projectID Project that owns both channels
 * @returns {Promise<void>} Save a rule for new events
 */
async function saveRule(userID, request, guard, projectID = null) {
    const monitorID = identifier(request?.monitorID);
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const monitor = await tx("monitor").where({ id: monitorID, user_id: userID }).forUpdate().first("type");
        if (!monitor || monitor.type === "group") {
            throw new Error("stage2InvalidRequest");
        }
        if (request.enabled === false) {
            await tx("monitor_alert_rule").where({ monitor_id: monitorID }).delete();
        } else {
            const telegramID = identifier(request.telegramID);
            const emailID = identifier(request.emailID);
            const rows = await tx("notification").where({ user_id: userID }).whereIn("id", [telegramID, emailID]);
            const telegram = rows.find((row) => row.id === telegramID);
            const email = rows.find((row) => row.id === emailID);
            if (!telegram || !email || projectOf(telegram) !== projectID || projectOf(email) !== projectID) {
                throw new Error("criticalAlertChannels");
            }
            const rule = {
                monitor_id: monitorID,
                revision: randomUUID(),
                telegram_id: telegramID,
                telegram_revision: telegram.delivery_revision,
                email_id: emailID,
                email_revision: email.delivery_revision,
            };
            const verified = await tx("notification_delivery")
                .where({
                    user_id: userID,
                    notification_id: email.id,
                    revision: email.delivery_revision,
                    kind: "test",
                })
                .whereNotNull("confirmed_at")
                .first("id");
            if (!verified || !(await emailRoute(tx, rule, userID))) {
                throw new Error("criticalAlertChannels");
            }
            await tx("monitor_alert_rule").insert(rule).onConflict("monitor_id").merge();
        }
        await guard(tx);
    });
}

/**
 * @param {object} db Current enqueue transaction
 * @param {object} job The original delivery
 * @param {number} now Current time
 * @returns {Promise<void>} Create an acknowledgement for selected operational alerts
 */
async function arm(db, job, now) {
    if (!events.includes(job.kind) || !job.monitor_id) {
        return;
    }
    const rule = await db("monitor_alert_rule")
        .where({
            monitor_id: job.monitor_id,
            telegram_id: job.notification_id,
            telegram_revision: job.revision,
        })
        .first();
    if (rule && (await emailRoute(db, rule, job.user_id))) {
        await db("notification_alert").insert({
            delivery_id: job.id,
            rule_revision: rule.revision,
            token: randomBytes(16).toString("base64url"),
            due_at: now + waitTime,
        });
    }
}

/**
 * @param {object} db Current database connection
 * @param {object} event Original delivery
 * @param {object} alert Retained policy revision
 * @returns {Promise<object|null>} Email route if the same policy still applies
 */
async function retainedRoute(db, event, alert) {
    const rule = await db("monitor_alert_rule")
        .where({
            monitor_id: event.monitor_id,
            revision: alert.rule_revision,
        })
        .first();
    return rule ? emailRoute(db, rule, event.user_id) : null;
}

/**
 * @param {object} db Current database connection
 * @param {object} job Primary delivery
 * @returns {Promise<object|null>} Ack metadata if the reserve route is still active
 */
async function activeAlert(db, job) {
    const alert = await db("notification_alert").where({ delivery_id: job.id }).first();
    return alert && (await retainedRoute(db, job, alert)) ? alert : null;
}

/**
 * @param {object} db Current database connection
 * @param {number} now Current time
 * @returns {Promise<void>} Schedule one fallback at most, in the original event's transaction
 */
async function scheduleDue(db, now) {
    const candidate = await db("notification_alert as a")
        .join("notification_delivery as d", "d.id", "a.delivery_id")
        .whereNull("a.closed_at")
        .whereNull("d.confirmed_at")
        .where((query) =>
            query
                .where("d.status", "failed")
                .orWhere((waiting) =>
                    waiting.whereIn("d.status", ["submitted", "uncertain"]).where("a.due_at", "<=", now)
                )
        )
        .orderBy("a.due_at")
        .first("a.delivery_id");
    if (!candidate) {
        return;
    }
    await db.transaction(async (tx) => {
        const event = await tx("notification_delivery").where({ id: candidate.delivery_id }).forUpdate().first();
        const alert = await tx("notification_alert")
            .where({ delivery_id: candidate.delivery_id })
            .whereNull("closed_at")
            .first();
        if (
            !event ||
            !alert ||
            event.confirmed_at ||
            (event.status !== "failed" && (!["submitted", "uncertain"].includes(event.status) || alert.due_at > now))
        ) {
            return;
        }
        const email = await retainedRoute(tx, event, alert);
        let fallbackID = null;
        if (email) {
            const pending = await tx("notification_delivery")
                .whereIn("status", ["queued", "sending"])
                .count({ n: "id" })
                .first();
            if (Number(pending.n) >= 1000) {
                return;
            }
            [fallbackID] = await tx("notification_delivery").insert({
                user_id: event.user_id,
                notification_id: email.id,
                monitor_id: event.monitor_id,
                revision: email.delivery_revision,
                kind: "fallback",
                payload: event.payload,
                event_key: "fallback:" + event.id,
                status: "queued",
                attempts: 0,
                created_at: now,
                updated_at: now,
                next_attempt_at: now,
            });
        }
        await tx("notification_alert")
            .where({ delivery_id: event.id })
            .update({ closed_at: now, fallback_id: fallbackID });
    });
}

/**
 * @param {object} db Current database connection
 * @param {object} job Reserve delivery
 * @returns {Promise<object|null>} Unacknowledged original Telegram event, revalidated before transport
 */
async function originalEvent(db, job) {
    const alert = await db("notification_alert").where({ fallback_id: job.id }).first();
    if (!alert) {
        return null;
    }
    const event = await db("notification_delivery")
        .where({ id: alert.delivery_id, user_id: job.user_id })
        .whereNull("confirmed_at")
        .first();
    if (!event || event.monitor_id !== job.monitor_id) {
        return null;
    }
    const email = await retainedRoute(db, event, alert);
    return email?.id === job.notification_id ? event : null;
}

/**
 * @param {Function} authorize Check private Telegram actor, project and channel
 * @param {number} channelID Bot-bound channel
 * @param {string} token Random callback value
 * @param {number} now Acknowledgement time
 * @returns {Promise<boolean>} Record receipt once, avoiding reserve delivery that has not started
 */
async function acknowledge(authorize, channelID, token, now = Date.now()) {
    if (!channelID || typeof token !== "string" || !tokenPattern.test(token)) {
        return false;
    }
    return R.knex.transaction(async (tx) => {
        const scope = await authorize("operator", tx);
        const alert = await tx("notification_alert").where({ token }).first();
        if (!alert) {
            return false;
        }
        const event = await tx("notification_delivery")
            .where({ id: alert.delivery_id, user_id: scope.data_user_id, notification_id: channelID })
            .whereIn("status", ["sending", "submitted", "uncertain"])
            .forUpdate()
            .first();
        if (!event || now - Number(event.created_at) > 24 * 60 * 60_000 || !(await retainedRoute(tx, event, alert))) {
            return false;
        }
        if (!event.confirmed_at) {
            await tx("notification_delivery").where({ id: event.id }).update({ confirmed_at: now });
        }
        await authorize("operator", tx);
        return true;
    });
}

module.exports = { waitTime, rulesForOwner, saveRule, arm, activeAlert, scheduleDue, originalEvent, acknowledge };
