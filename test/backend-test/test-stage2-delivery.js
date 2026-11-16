const { test } = require("node:test");
const assert = require("node:assert/strict");
const { R } = require("redbean-node");
const {
    DeliveryQueue,
    saveManagedChannel,
    deleteManagedChannel,
    deliveryOverview,
    confirmReceipt,
    monitorMessage,
    requestTest,
} = require("../../server/notification-delivery");
const { managedAlertConfig } = require("../../server/managed-alert-config");
const { deliveryFailure } = require("../../server/notification-delivery");
const { deliverySocketHandler } = require("../../server/socket-handlers/delivery-socket-handler");
const migration = require("../../db/knex_migrations/2026-11-01-0300-monitor-alert-workflow");
const smtp = {
    type: "smtp",
    name: "Owner mail",
    smtpHost: "localhost",
    smtpPort: 465,
    smtpSecure: true,
    smtpUsername: "owner",
    smtpPassword: " secret with spaces ",
    smtpFrom: "from@example.test",
    smtpTo: "to@example.test",
    locale: "ru",
};

/**
 * @param {TestContext} context Test lifecycle
 * @returns {Promise<object>} Isolated real SQLite and a controllable worker
 */
async function fixture(context) {
    const Dialect = require("knex/lib/dialects/sqlite3");
    Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
    const db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
    context.after(() => db.destroy());
    R.setup(db);
    await db.raw("PRAGMA foreign_keys=ON");
    await db.schema.createTable("user", (t) => t.increments("id"));
    await db.schema.createTable("monitor", (t) => {
        t.increments("id");
        t.integer("user_id");
        t.text("type");
        t.text("name");
        t.integer("active");
        t.integer("parent").nullable();
    });
    await db.schema.createTable("notification", (t) => {
        t.increments("id");
        t.integer("user_id");
        t.text("name");
        t.text("config");
        t.integer("is_default").defaultTo(0);
    });
    await db.schema.createTable("monitor_notification", (t) => {
        t.integer("monitor_id");
        t.integer("notification_id");
        t.primary(["monitor_id", "notification_id"]);
    });
    await db.schema.createTable("heartbeat", (t) => {
        t.increments("id");
        t.integer("monitor_id");
        t.text("time");
        t.integer("status");
        t.text("msg");
    });
    await db("user").insert([{ id: 1 }, { id: 2 }]);
    await db("monitor").insert([
        { id: 1, user_id: 1, type: "http", name: "Owned", active: 1 },
        { id: 2, user_id: 2, type: "http", name: "Other owner", active: 1 },
    ]);
    await migration.up(db);
    await require("../../db/knex_migrations/2026-11-16-0000-monitor-alert-rules").up(db);
    await db("heartbeat").insert({ monitor_id: 1, time: new Date().toISOString(), status: 0 });
    const clock = { time: Date.now() };
    const sent = [];
    const worker = new DeliveryQueue({
        db,
        now: () => clock.time,
        send: async (config, payload) => sent.push({ config, payload }),
        isUnderMaintenance: async () => false,
    });
    const id = await saveManagedChannel(1, { config: smtp, monitorIDs: [1] });
    return { db, clock, sent, worker, id };
}

test("work notices require the same fresh explicit server signal even though ordinary maintenance notices are suppressed", async (context) => {
    const { db, clock, sent, worker, id } = await fixture(context);
    const work = { kind: "update", phase: "verifying", startedAt: clock.time - 1000, deadline: clock.time + 60000, runID: "b".repeat(64) };
    await db("heartbeat").update({ status: 3, msg: require("../../src/site-work.ts").workMessage(work) });
    worker.options.isUnderMaintenance = async () => true;
    worker.options.siteWork = async () => ({ state: "active", work });
    const accepted = await worker.enqueue(1, id, "work", "Update started", "site-work:1:" + work.runID, 1, 1);
    await worker.tick();
    assert.equal((await db("notification_delivery").where({ id: accepted }).first()).status, "submitted");
    assert.equal(sent.length, 1);
    for (const state of ["idle", "overdue", "unavailable"]) {
        worker.options.siteWork = async () => ({ state, work });
        const stale = await worker.enqueue(1, id, "work", "Old update", "work:" + state, 1, 1);
        await worker.tick();
        assert.equal((await db("notification_delivery").where({ id: stale }).first()).status, "cancelled");
    }
    worker.options.siteWork = async () => ({ state: "active", work: { ...work, runID: "c".repeat(64) } });
    const replaced = await worker.enqueue(1, id, "work", "Replaced update", "work:replaced", 1, 1);
    await worker.tick();
    assert.equal((await db("notification_delivery").where({ id: replaced }).first()).status, "cancelled");
    assert.equal(sent.length, 1);
});

test("managed configuration preserves exact passwords, enforces TLS and cannot change Telegram destination service", () => {
    const config = managedAlertConfig({ ...smtp, smtpIgnoreTLSError: true, smtpIgnoreSTARTTLS: true });
    assert.equal(config.smtpPassword, " secret with spaces ");
    assert.equal(config.smtpIgnoreTLSError, false);
    assert.equal(config.smtpIgnoreSTARTTLS, false);
    assert.equal(config.smtpRequireTLS, true);
    assert.equal(managedAlertConfig({ ...smtp, smtpPassword: "" }, config).smtpPassword, config.smtpPassword);
    assert.throws(() => managedAlertConfig({ ...smtp, smtpTo: "to@example.test\r\nBcc: victim@example.test" }));
    assert.throws(() => managedAlertConfig({ ...smtp, smtpPort: "465" }));
    const telegram = managedAlertConfig({
        type: "telegram",
        name: "Bot",
        telegramBotToken: "123456:" + "x".repeat(30),
        telegramChatID: "-10012345678",
        telegramServerUrl: "https://attacker.test",
    });
    assert.equal(telegram.telegramServerUrl, "https://api.telegram.org");
});

test("channel save is atomic, owner-scoped and invalidates previous verification", async (context) => {
    const { db, id } = await fixture(context);
    await assert.rejects(
        saveManagedChannel(1, { id, revision: 1, config: { ...smtp, name: "Changed" }, monitorIDs: [2] }),
        /stage2InvalidRequest/
    );
    assert.equal((await db("notification").where({ id }).first()).name, smtp.name);
    await assert.rejects(
        saveManagedChannel(2, { id, revision: 1, config: smtp, monitorIDs: [] }),
        /stage2ChannelChanged/
    );
    await saveManagedChannel(1, { id, revision: 1, config: { ...smtp, smtpPassword: "" }, monitorIDs: [] });
    assert.equal((await db("notification").where({ id }).first()).delivery_revision, 2);
    assert.equal((await db("monitor_notification")).length, 0);
    await assert.rejects(
        saveManagedChannel(1, { id, revision: 1, config: smtp, monitorIDs: [1] }),
        /stage2ChannelChanged/
    );
    const overview = await deliveryOverview(1);
    assert.equal(JSON.stringify(overview).includes("secret with spaces"), false);
    assert.equal(overview.channels[0].hasSecret, true);
    await assert.rejects(deliveryOverview(1, 2), /stage2InvalidRequest/);
    assert.equal((await deliveryOverview(2)).channels.length, 0);
});

test("durable tests separate queueing, provider acceptance and explicit owner confirmation", async (context) => {
    const { db, id, worker, sent, clock } = await fixture(context);
    const job = await requestTest(1, { id, revision: 1 });
    clock.time = Date.now() + 1;
    await assert.rejects(confirmReceipt(1, job), /stage2ConfirmationInvalid/);
    assert.equal((await db("notification_delivery").where({ id: job }).first()).status, "queued");
    await worker.tick();
    assert.equal(sent.length, 1);
    let record = await db("notification_delivery").where({ id: job }).first();
    assert.equal(record.status, "submitted");
    assert.equal(record.confirmed_at, null);
    await assert.rejects(confirmReceipt(2, job), /stage2ConfirmationInvalid/);
    await confirmReceipt(1, job);
    record = await db("notification_delivery").where({ id: job }).first();
    assert.ok(record.confirmed_at > 0);
    await assert.rejects(requestTest(1, { id, revision: 1 }), /stage2TestCooldown/);
    await saveManagedChannel(1, { id, revision: 1, config: smtp, monitorIDs: [1] });
    await assert.rejects(confirmReceipt(1, job), /stage2ConfirmationInvalid/);
    const overview = await deliveryOverview(1);
    assert.equal(JSON.stringify(overview).includes("secret with spaces"), false);
    assert.equal(Object.hasOwn(overview.deliveries[0], "payload"), false);
});

test("channel removal requires the owner and current revision and cancels pending delivery by cascade", async (context) => {
    const { db, id, worker, sent } = await fixture(context);
    await worker.enqueue(1, id, "down", "Safe", "to-delete", 1, 1);
    await assert.rejects(deleteManagedChannel(2, { id, revision: 1 }), /stage2ChannelChanged/);
    await assert.rejects(deleteManagedChannel(1, { id, revision: 2 }), /stage2ChannelChanged/);
    await deleteManagedChannel(1, { id, revision: 1 });
    assert.equal((await db("notification_delivery")).length, 0);
    assert.equal((await db("monitor_notification")).length, 0);
    await worker.tick();
    assert.equal(sent.length, 0);
    assert.equal((await db("heartbeat")).length, 1);
});

test("explicit rejection retries at most three times; no duplicate event is enqueued", async (context) => {
    const { worker, clock, db, id } = await fixture(context);
    worker.options.send = async () => {
        throw Object.assign(new Error("credential-bearing error must stay private"), { responseCode: 451 });
    };
    const job = await worker.enqueue(1, id, "down", "Safe message", "event-1", 1, 1);
    assert.equal(await worker.enqueue(1, id, "down", "Safe message", "event-1", 1, 1), job);
    await worker.tick();
    assert.equal((await db("notification_delivery").first()).status, "queued");
    await worker.tick();
    assert.equal((await db("notification_delivery").first()).attempts, 1);
    clock.time += 30000;
    await worker.tick();
    clock.time += 60000;
    await worker.tick();
    const result = await db("notification_delivery").first();
    assert.equal(result.status, "failed");
    assert.equal(result.attempts, 3);
    assert.equal(result.error_code, "unavailable");
    assert.equal(JSON.stringify(await deliveryOverview(1)).includes("credential-bearing"), false);
});

test("timeouts and interrupted sending stay uncertain and are not automatically repeated", async (context) => {
    const { worker, db, id } = await fixture(context);
    worker.options.send = async () => {
        throw Object.assign(new Error("token=private"), { code: "ETIMEDOUT" });
    };
    await worker.enqueue(1, id, "down", "Safe", "timeout", 1, 1);
    await worker.tick();
    await worker.tick();
    assert.equal((await db("notification_delivery").first()).status, "uncertain");
    assert.equal((await db("notification_delivery").first()).attempts, 1);
    await db("notification_delivery").update({ status: "sending" });
    await worker.start();
    await worker.stop();
    assert.equal((await db("notification_delivery").first()).error_code, "interrupted");
});

test("changed channel revisions, paused checks, recovery and maintenance cancel stale queued alerts", async (context) => {
    const { worker, db, id, sent, clock } = await fixture(context);
    await worker.enqueue(1, id, "down", "Safe", "changed", 1, 1);
    await db("notification").where({ id }).update({ delivery_revision: 2 });
    await worker.tick();
    assert.equal((await db("notification_delivery").where({ event_key: "changed" }).first()).status, "cancelled");
    await worker.enqueue(1, id, "down", "Safe", "paused", 1, 2);
    await db("monitor").where({ id: 1 }).update({ active: 0 });
    await worker.tick();
    await db("monitor").where({ id: 1 }).update({ active: 1 });
    await worker.enqueue(1, id, "down", "Safe", "recovered", 1, 2);
    clock.time += 1000;
    await db("heartbeat").insert({ monitor_id: 1, time: new Date(clock.time).toISOString(), status: 1 });
    await worker.tick();
    await worker.enqueue(1, id, "up", "Safe", "maintenance", 1, 2);
    worker.options.isUnderMaintenance = async () => true;
    await worker.tick();
    assert.equal(sent.length, 0);
    assert.equal((await db("notification_delivery").where({ status: "cancelled" })).length, 4);
    await assert.rejects(worker.enqueue(1, id, "test", "Safe", "wrong-revision", null, 1), /stage2ChannelChanged/);
});

test("new socket actions require login, an acknowledgement and the same live owner", async (context) => {
    await fixture(context);
    const handlers = {};
    const socket = {
        userID: null,
        on: (name, handler) => {
            handlers[name] = handler;
        },
    };
    deliverySocketHandler(socket, async () => {});
    let result;
    await handlers.getNotificationDelivery({}, (value) => {
        result = value;
    });
    assert.equal(result.ok, false);
    assert.equal(result.channels, undefined);
    await handlers.saveManagedNotification({ config: smtp, monitorIDs: [] });
    socket.userID = 1;
    await handlers.getNotificationDelivery({ monitorID: 2 }, (value) => {
        result = value;
    });
    assert.equal(result.ok, false);
    await handlers.getNotificationDelivery({}, (value) => {
        result = value;
    });
    assert.equal(result.ok, true);
    assert.equal(result.channels.length, 1);
});

test("a paused parent cancels delayed failure mail without hiding the saved failure", async (context) => {
    const { db, worker, id, sent } = await fixture(context);
    await db("monitor").insert({ id: 3, user_id: 1, type: "group", name: "Paused parent", active: 0 });
    await db("monitor").where({ id: 1 }).update({ parent: 3 });
    await worker.enqueue(1, id, "down", "Safe", "parent-paused", 1, 1);
    await worker.tick();
    assert.equal(sent.length, 0);
    assert.equal((await db("notification_delivery").first()).status, "cancelled");
    assert.equal((await db("heartbeat").first()).status, 0);
});

test("a login change before test enqueue or receipt commit rolls the action back", async (context) => {
    const { db, worker, id, clock } = await fixture(context);
    let guards = 0;
    await assert.rejects(
        requestTest(1, { id, revision: 1 }, () => {
            if (++guards > 1) {
                throw new Error("owner changed");
            }
        }),
        /owner changed/
    );
    assert.equal((await db("notification_delivery")).length, 0);
    const job = await requestTest(1, { id, revision: 1 });
    clock.time = Date.now() + 1;
    await worker.tick();
    guards = 0;
    await assert.rejects(
        confirmReceipt(1, job, () => {
            if (++guards > 1) {
                throw new Error("owner changed");
            }
        }),
        /owner changed/
    );
    assert.equal((await db("notification_delivery").first()).confirmed_at, null);
});

test("managed Telegram checks provider acceptance, bounds requests and never follows redirects", async (context) => {
    const Telegram = require("../../server/notification-providers/telegram");
    const axios = require("axios");
    const telegram = managedAlertConfig({
        type: "telegram",
        name: "Test",
        telegramBotToken: "123456:" + "x".repeat(30),
        telegramChatID: "-10012345678",
    });
    let response = { data: { ok: true } };
    const calls = [];
    context.mock.method(axios, "post", async (url, params, config) => {
        calls.push({ url, params, config });
        return response;
    });
    const provider = new Telegram();
    await provider.send(telegram, "Safe test");
    assert.equal(calls[0].url, `https://api.telegram.org/bot${telegram.telegramBotToken}/sendMessage`);
    assert.equal(calls[0].config.timeout, 15000);
    assert.equal(calls[0].config.maxRedirects, 0);
    assert.equal(calls[0].config.maxContentLength, 65536);
    assert.equal(calls[0].params.link_preview_options.is_disabled, true);
    assert.equal(calls[0].params.parse_mode, undefined);
    assert.equal(calls[0].params.reply_markup, undefined);
    const token = "x".repeat(22);
    await provider.send({ ...telegram, locale: "ru", telegramAlertToken: token }, "Safe alert");
    assert.deepEqual(calls[1].params.reply_markup, {
        inline_keyboard: [[{ text: "Принял", callback_data: "alert:" + token }]],
    });
    response = { data: { ok: false, description: "not accepted" } };
    await assert.rejects(provider.send(telegram, "Safe test"), /not confirmed/);
});

test("legacy certificate history cannot suppress a new managed channel or renewal identity", async (context) => {
    const { id } = await fixture(context);
    const Monitor = require("../../server/model/monitor");
    const { queue } = require("../../server/notification-delivery");
    const { Notification } = require("../../server/notification");
    const calls = [];
    context.mock.method(R, "getRow", async () => ({ id: 1 }));
    context.mock.method(queue, "enqueue", async (...args) => calls.push(args));
    context.mock.method(Notification, "send", async () => {
        throw new Error("Legacy message repeated");
    });
    const monitor = { id: 1, user_id: 1, url: "https://owner:secret@example.test/private?token=hidden" };
    const channels = [
        { id, delivery_revision: 1, config: JSON.stringify({ ...smtp, managedDelivery: true }) },
        { id: 99, config: JSON.stringify(smtp) },
    ];
    await Monitor.prototype.sendCertNotificationByTargetDays.call(
        monitor,
        "example.test",
        "leaf",
        5,
        7,
        channels,
        "certificate-one"
    );
    await Monitor.prototype.sendCertNotificationByTargetDays.call(
        monitor,
        "example.test",
        "leaf",
        5,
        7,
        channels,
        "certificate-two"
    );
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0][4], calls[1][4]);
    assert.equal(calls[0][3].includes("secret"), false);
    assert.equal(calls[0][3].includes("private"), false);
});

test("domain expiry uses the durable managed queue even after a legacy deadline was recorded", async (context) => {
    const { id } = await fixture(context);
    const DomainExpiry = require("../../server/model/domain_expiry");
    const { Settings } = require("../../server/settings");
    const { queue } = require("../../server/notification-delivery");
    const { Notification } = require("../../server/notification");
    const calls = [];
    context.mock.method(DomainExpiry, "findByDomainNameOrCreate", async () => ({
        expiry: "2026-11-06 12:00:00",
        daysRemaining: 5,
        lastExpiryNotificationSent: 7,
    }));
    context.mock.method(Settings, "get", async () => [7, 14, 21]);
    context.mock.method(queue, "enqueue", async (...args) => calls.push(args));
    context.mock.method(Notification, "send", async () => {
        assert.fail("Managed domain mail bypassed its queue");
    });
    const monitor = { id: 1, user_id: 1, url: "https://owner:secret@example.test/private?token=hidden" };
    await DomainExpiry.sendNotifications(
        "example.test",
        [{ id, delivery_revision: 1, config: JSON.stringify({ ...smtp, managedDelivery: true }) }],
        monitor
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], "domain");
    assert.equal(calls[0][3].includes("secret"), false);
    assert.equal(calls[0][3].includes("private"), false);
});

test("notification messages remove URL credentials, private paths, queries and remote instructions", () => {
    const message = monitorMessage(
        { name: "Site", url: "https://owner:password@example.test/private/signed?token=private" },
        { status: 0, time: "2026-11-01 12:00:00", msg: "HTTP 404, run malicious command token=hidden" }
    );
    assert.match(message, /example.test/);
    for (const secret of ["owner", "password", "signed", "token", "malicious", "private"]) {
        assert.equal(message.includes(secret), false);
    }
    const monitor = { id: 12, name: "Site", url: "https://example.test" };
    const beat = { status: 0, time: "2026-11-01 12:00:00", msg: "HTTP 404" };
    assert.match(
        monitorMessage(monitor, beat, "en", "https://monitor.example.test/private?token=hidden"),
        /https:\/\/monitor\.example\.test\/dashboard\/12$/
    );
    assert.match(
        monitorMessage(monitor, beat, "en", "https://monitor.example.test/private?token=hidden", 7),
        /https:\/\/monitor\.example\.test\/projects\/7\?check=12$/
    );
    assert.equal(
        monitorMessage(monitor, beat, "en", "https://owner:secret@monitor.example.test").includes("monitor.example"),
        false
    );
    assert.equal(monitorMessage(monitor, beat, "en", "javascript:alert(1)").includes("javascript"), false);
});

test("notification list updates never disclose managed secrets or cross a changed owner", async (context) => {
    await fixture(context);
    const server = require("../../server/uptime-kuma-server").UptimeKumaServer.getInstance();
    const { sendNotificationList } = require("../../server/client");
    const emissions = [];
    context.mock.method(server.io, "to", (owner) => ({
        emit: (event, value) => emissions.push({ owner, event, value }),
    }));
    const socket = { userID: 1 };
    const beans = [
        {
            export: () => ({
                id: 1,
                name: "Mail",
                config: JSON.stringify({ ...smtp, managedDelivery: true }),
                isDefault: 0,
                active: 1,
            }),
        },
    ];
    context.mock.method(R, "find", async () => beans);
    await sendNotificationList(socket);
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].owner, 1);
    assert.equal(JSON.stringify(emissions).includes("secret with spaces"), false);
    assert.equal(JSON.parse(emissions[0].value[0].config).hasSecret, true);
    context.mock.method(R, "find", async () => {
        socket.userID = 2;
        return beans;
    });
    await sendNotificationList(socket);
    assert.equal(emissions.length, 1);
});

test("only one transport runs at once and an authorization change rolls back channel edits", async (context) => {
    const { worker, id, db } = await fixture(context);
    let release;
    let entered;
    const waiting = new Promise((resolve) => {
        entered = resolve;
    });
    const hold = new Promise((resolve) => {
        release = resolve;
    });
    let calls = 0;
    worker.options.send = async () => {
        calls++;
        entered();
        await hold;
    };
    await worker.enqueue(1, id, "down", "Safe", "first", 1, 1);
    await worker.enqueue(1, id, "down", "Safe", "second", 1, 1);
    const first = worker.tick();
    await waiting;
    await worker.tick();
    assert.equal(calls, 1);
    release();
    await first;
    await worker.tick();
    assert.equal(calls, 2);
    let guards = 0;
    await assert.rejects(
        saveManagedChannel(1, { id, revision: 1, config: { ...smtp, name: "Uncommitted" }, monitorIDs: [] }, () => {
            if (++guards > 1) {
                throw new Error("account changed");
            }
        }),
        /account changed/
    );
    assert.equal((await db("notification").where({ id }).first()).name, smtp.name);
    assert.equal((await db("monitor_notification")).length, 1);
});

test("a provider rate pause applies to every pending message and manual tests for that channel", async (context) => {
    const { worker, id, db, clock } = await fixture(context);
    let calls = 0;
    worker.options.send = async () => {
        calls++;
        throw Object.assign(new Error("Provider rate limit"), {
            response: { status: 429, data: { parameters: { retry_after: 7200 } } },
        });
    };
    await worker.enqueue(1, id, "down", "Safe", "limited", 1, 1);
    await worker.tick();
    await worker.enqueue(1, id, "down", "Safe", "later", 1, 1);
    await worker.tick();
    assert.equal(calls, 1);
    const jobs = await db("notification_delivery").orderBy("id");
    assert.equal(jobs[0].next_attempt_at, clock.time + 7200000);
    assert.equal(jobs[1].next_attempt_at, jobs[0].next_attempt_at);
    assert.equal(jobs[1].attempts, 0);
    await assert.rejects(worker.enqueue(1, id, "test", "Safe", "manual"), /stage2ProviderCooldown/);
    assert.equal(deliveryFailure({ code: "ESOCKET", originalCode: "ECONNREFUSED" }).retry, true);
});

test("the additive migration preserves old monitoring data and can be rolled back", async (context) => {
    const { db } = await fixture(context);
    await migration.down(db);
    assert.equal((await db("monitor")).length, 2);
    assert.equal((await db("notification")).length, 1);
    assert.equal(await db.schema.hasColumn("monitor", "max_response_time"), false);
    assert.equal(await db.schema.hasTable("notification_delivery"), false);
});
