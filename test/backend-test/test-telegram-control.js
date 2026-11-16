const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const ai = require("../../server/projects/ai-service");
const { TelegramControlBot } = require("../../server/telegram-control/bot");
const { controlConnection } = require("../../server/telegram-control");
const { projectMonitors } = require("../../server/telegram-control/monitors");
const { createTransport, readConfig } = require("../../server/telegram-control/transport");
const vaultModule = require("../../server/projects/vault");
const Telegram = require("../../server/notification-providers/telegram");
const Maintenance = require("../../server/model/maintenance");
const { UptimeKumaServer } = require("../../server/uptime-kuma-server");
const { maintenanceSocketHandler } = require("../../server/socket-handlers/maintenance-socket-handler");

const telegramUserId = 4815162342;
const token = "123456789:" + "a".repeat(35);
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));

/**
 * @param {object} context Test lifecycle
 * @returns {Promise<object>} Fresh migrated SQLite project with unrelated data
 */
async function setup(context) {
    const Dialect = require("knex/lib/dialects/sqlite3");
    Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
    const db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
    R.setup(db);
    context.after(async () => {
        Settings.stopCacheCleaner();
        Settings.deleteCache(["primaryBaseURL"]);
        await db.destroy();
    });
    await require("../../db/knex_init_db").createTables();
    await db.migrate.latest({ directory: path.resolve(__dirname, "../../db/knex_migrations") });
    const [userId] = await db("user").insert({ username: "telegram-owner" });
    const [other] = await db("user").insert({ username: "other-owner" });
    const [projectId] = await db("project").insert({
        owner_id: userId,
        data_user_id: userId,
        name: "Telegram Test",
        timezone: "Europe/Moscow",
        personal: 1,
        allowed_ips_json: "[]",
        created_at: 1,
    });
    await db("project_member").insert({ project_id: projectId, user_id: userId, role: "operator" });
    const [monitor] = await db("monitor").insert({
        user_id: userId,
        name: "Рабочий сайт",
        type: "http",
        url: "https://test:password@example.com/?secret=signed",
    });
    const [foreign] = await db("monitor").insert({ user_id: other, name: "Чужой сайт", type: "http" });
    const [group] = await db("monitor").insert({ user_id: userId, name: "Группа", type: "group", active: 0 });
    const [child] = await db("monitor").insert({
        user_id: userId,
        name: "Проверка в группе",
        type: "http",
        parent: group,
    });
    const now = Date.now();
    const sql = (time) => new Date(time).toISOString().replace("T", " ").slice(0, 23);
    await db("heartbeat").insert([
        { monitor_id: monitor, time: sql(now - 6000), status: 1, ping: 100, check_interval: 20, check_session: "same" },
        {
            monitor_id: monitor,
            time: sql(now - 1000),
            status: 0,
            msg: "HTTP 503 private-remote-error",
            check_interval: 20,
            check_session: "same",
        },
        { monitor_id: monitor, time: sql(now + 60000), status: 1 },
        { monitor_id: child, time: sql(now - 1000), status: 1 },
    ]);
    await db("monitor_tls_info").insert([
        {
            monitor_id: monitor,
            info_json: JSON.stringify({ certInfo: { validTo: new Date(now + 86400000), private: "private-cert" } }),
        },
        { monitor_id: foreign, info_json: JSON.stringify({ certInfo: { validTo: new Date(now + 86400000) } }) },
    ]);
    const [notification] = await db("notification").insert({
        user_id: userId,
        name: "Test notifications",
        config: "{}",
    });
    await db("notification_delivery").insert({
        user_id: userId,
        notification_id: notification,
        revision: 1,
        kind: "test",
        status: "submitted",
        event_key: "test",
        created_at: now,
        updated_at: now,
        next_attempt_at: now,
        payload: "private-payload",
    });
    await db("setting").insert({ key: "primaryBaseURL", value: JSON.stringify("https://panel.example/?secret=token") });
    const sync = context.mock.fn(async () => {});
    return {
        db,
        monitor,
        foreign,
        group,
        child,
        projectId,
        userId,
        notification,
        sync,
        ops: projectMonitors({ userId, projectId }, { sync, isUnderMaintenance: () => false }),
    };
}

test("Telegram views use scoped, saved evidence and omit raw errors, credentials and notification content", async (context) => {
    const { monitor, foreign, group, child, ops } = await setup(context);
    const summary = await ops.list();
    assert.deepEqual(summary.counts, { up: 0, down: 1, pending: 0, maintenance: 0, paused: 1, unknown: 0 });
    assert.deepEqual(
        (await ops.list("issues")).monitors.map((entry) => entry.id),
        [monitor]
    );
    assert.deepEqual(
        (await ops.list("all", 0, "ГРУППЕ")).monitors.map((entry) => entry.id),
        [child]
    );
    const detail = await ops.detail(monitor);
    assert.equal(detail.host, "example.com");
    assert.equal(detail.state, "down");
    assert.equal(detail.explanation, "workspaceIssueServer");
    assert.ok(detail.confirmedAt);
    assert.equal(detail.url, `https://panel.example/dashboard/${monitor}`);
    assert.equal(detail.recent.length, 2);
    assert.equal((await ops.report(monitor)).counts.total, 2);
    assert.deepEqual(
        (await ops.certificates(0)).certificates.map((entry) => entry.id),
        [monitor]
    );
    const deliveries = await ops.deliveries();
    assert.equal(deliveries.rows[0].status, "submitted");
    assert.doesNotMatch(JSON.stringify([detail, deliveries]), /private-|secret|password|signed/);
    await assert.rejects(ops.detail(foreign), /projectAccessDenied/);
    await assert.rejects(ops.detail(group), /projectAccessDenied/);
});

test("confirmation rechecks rights, current state and ownership; writes include a single audit entry", async (context) => {
    const { db, monitor, foreign, child, projectId, userId, ops, sync } = await setup(context);
    const request = await ops.prepare("pause", monitor);
    await db("project_member").where({ project_id: projectId, user_id: userId }).update({ role: "viewer" });
    assert.equal((await ops.detail(monitor)).canControl, false);
    await assert.rejects(ops.apply(request), /projectAccessDenied/);
    await db("project_member").where({ project_id: projectId, user_id: userId }).update({ role: "operator" });
    await assert.rejects(ops.prepare("pause", foreign), /projectAccessDenied/);
    await assert.rejects(ops.prepare("maintenance", child, 15), /telegramParentPaused/);
    await db("monitor").where({ id: monitor }).update({ name: "New name" });
    await assert.rejects(ops.apply(request), /projectChanged/);
    assert.equal(sync.mock.callCount(), 0);
    const paused = await ops.prepare("pause", monitor);
    await ops.apply(paused);
    assert.equal((await ops.detail(monitor)).state, "paused");
    await assert.rejects(ops.apply(paused), /projectChanged/);
    await ops.apply(await ops.prepare("resume", monitor));
    assert.equal((await db("monitor").where({ id: monitor }).first()).active, 1);
    assert.equal(sync.mock.callCount(), 2);
    assert.deepEqual(
        (await ops.journal()).rows.map((row) => row.action),
        ["telegramMonitorResumed", "telegramMonitorPaused"]
    );
    await db("setting").insert({ key: "disableAuth", value: "true" });
    await assert.rejects(ops.list(), /projectAccessDenied/);
});

test("timed maintenance is stored with its monitor, expires by time and can only end its original window", async (context) => {
    const { db, monitor, child, ops, sync } = await setup(context);
    const start = await ops.prepare("maintenance", monitor, 15);
    const window = await ops.apply(start);
    const row = await db("maintenance").where({ id: window.maintenanceID }).first();
    assert.equal(Date.parse(row.end_date.replace(" ", "T") + "Z"), window.end);
    const saved = Object.assign(Object.create(Maintenance.prototype), row);
    assert.equal(await saved.getStatus(), "under-maintenance");
    assert.equal((await ops.windows()).rows[0].monitorID, monitor);
    await assert.rejects(ops.apply(start), /telegramMaintenanceUnavailable/);
    const end = await ops.prepare("end", monitor, window.maintenanceID);
    await db("monitor_maintenance").where({ maintenance_id: window.maintenanceID }).update({ monitor_id: child });
    await assert.rejects(ops.apply(end), /projectChanged/);
    await db("monitor_maintenance").where({ maintenance_id: window.maintenanceID }).update({ monitor_id: monitor });
    await ops.apply(end);
    assert.equal((await db("maintenance").where({ id: window.maintenanceID }).first()).active, 0);
    const next = await ops.apply(await ops.prepare("maintenance", monitor, 15));
    const nextRow = await db("maintenance").where({ id: next.maintenanceID }).first();
    const future = new Date(next.end + 1000);
    context.mock.timers.enable({ apis: ["Date"], now: future });
    assert.equal(await Object.assign(Object.create(Maintenance.prototype), nextRow).getStatus(), "ended");
    assert.equal((await ops.windows()).rows.length, 0);
    assert.equal(sync.mock.callCount(), 3);
});

test("a maintenance started between preview and confirmation blocks an overlapping window", async (context) => {
    const { db, monitor, userId, ops } = await setup(context);
    const request = await ops.prepare("maintenance", monitor, 15);
    const [maintenanceID] = await db("maintenance").insert({
        user_id: userId,
        title: "Panel maintenance",
        description: "",
        active: 1,
        strategy: "manual",
    });
    await db("monitor_maintenance").insert({ monitor_id: monitor, maintenance_id: maintenanceID });
    await assert.rejects(ops.apply(request), /telegramMaintenanceUnavailable/);
    assert.equal((await ops.journal()).rows.length, 0);
});

test("the browser maintenance list exposes windows only to their data owner", async () => {
    const server = UptimeKumaServer.getInstance();
    const original = server.maintenanceList;
    server.maintenanceList = {
        1: { id: 1, user_id: 10, toJSON: async () => ({ id: 1 }) },
        2: { id: 2, user_id: 11, toJSON: async () => ({ id: 2 }) },
    };
    try {
        assert.deepEqual(await server.getMaintenanceJSONList(10), { 1: { id: 1 } });
    } finally {
        server.maintenanceList = original;
    }
});

test("browser maintenance commands reject changes to windows and monitors owned by another account", async (context) => {
    const { db, monitor, foreign, userId, ops } = await setup(context);
    const { maintenanceID } = await ops.apply(await ops.prepare("maintenance", monitor, 15));
    const foreignOwner = (await db("monitor").where({ id: foreign }).first("user_id")).user_id;
    const server = UptimeKumaServer.getInstance();
    server.maintenanceList[maintenanceID] = { user_id: userId, stop: context.mock.fn() };
    context.after(() => delete server.maintenanceList[maintenanceID]);
    const handlers = {};
    const socket = {
        userID: foreignOwner,
        on: (name, handler) => {
            handlers[name] = handler;
        },
    };
    maintenanceSocketHandler(socket);
    for (const event of ["pauseMaintenance", "resumeMaintenance", "deleteMaintenance", "getMonitorMaintenance"]) {
        await handlers[event](maintenanceID, (reply) => assert.equal(reply.ok, false));
    }
    await handlers.addMonitorMaintenance(maintenanceID, [], (reply) => assert.equal(reply.ok, false));
    assert.equal(server.maintenanceList[maintenanceID].stop.mock.callCount(), 0);
    socket.userID = userId;
    await handlers.addMonitorMaintenance(maintenanceID, [{ id: foreign }], (reply) => assert.equal(reply.ok, false));
    assert.equal(
        (await db("monitor_maintenance").where({ maintenance_id: maintenanceID }).first()).monitor_id,
        monitor
    );
});

test("buttons are private, tied to one chat message, cancellable and accepted once", async (context) => {
    const operations = {
        prepare: context.mock.fn(async (action, monitorID) => ({ action, monitorID, name: "Сайт" })),
        apply: context.mock.fn(async (request) => request),
    };
    const call = context.mock.fn(async (method) => (method === "sendMessage" ? { message_id: 9 } : true));
    const bot = new TelegramControlBot({ telegramUserId }, operations, call, () => {});
    const press = (data, messageId = 9, author = telegramUserId, type = "private", isBot = false) =>
        bot.handle({
            callback_query: {
                id: "sample",
                from: { id: author, is_bot: isBot },
                message: { message_id: messageId, chat: { id: telegramUserId, type } },
                data,
            },
        });
    await press("prepare:pause:1", 7, telegramUserId + 1);
    await press("prepare:pause:1", 7, telegramUserId, "group");
    await press("prepare:pause:1", 7, telegramUserId, "private", true);
    assert.equal(call.mock.callCount(), 0);
    await press("prepare:pause:1", 7);
    const sent = call.mock.calls.find(({ arguments: [method] }) => method === "sendMessage").arguments[1];
    const [yes, no] = sent.reply_markup.inline_keyboard[0].map((item) => item.callback_data);
    assert.equal(sent.protect_content, true);
    await press(yes, 8);
    assert.equal(operations.apply.mock.callCount(), 0);
    await press(no);
    await press(yes);
    assert.equal(operations.apply.mock.callCount(), 0);
    await press("prepare:resume:1", 7);
    const fresh = bot.approval.key;
    await press(`yes:${fresh}`);
    await press(`yes:${fresh}`);
    assert.equal(operations.apply.mock.callCount(), 1);
    await press("prepare:resume:1", 7);
    bot.approval.expires = Date.now();
    await press(`yes:${bot.approval.key}`);
    assert.equal(operations.apply.mock.callCount(), 1);
});

/**
 * @param {object} config Bound Telegram account
 * @param {object} operations Real project operations
 * @returns {object} A Telegram chat backed by an in-process Bot API transport
 */
function testChat(config, operations) {
    const replies = [];
    let messageID = 100;
    const bot = new TelegramControlBot(
        config,
        operations,
        async (method, body) => {
            if (method === "editMessageText" || method === "sendMessage") {
                assert.ok(body.text.length > 0 && body.text.length <= 4096);
                assert.ok(
                    body.reply_markup.inline_keyboard
                        .flat()
                        .every(({ callback_data: data }) => !data || Buffer.byteLength(data) <= 64)
                );
                const id = method === "sendMessage" ? ++messageID : body.message_id;
                replies.push({ ...body, id, buttons: body.reply_markup.inline_keyboard.flat() });
                return { message_id: id };
            }
            return true;
        },
        () => {}
    );
    const from = { id: config.telegramUserId, is_bot: false };
    const chat = { id: config.telegramUserId, type: "private" };
    return {
        async command(text) {
            const before = replies.length;
            await bot.handle({ message: { from, chat, text } });
            return replies[before];
        },
        async press(data, id = 7, sender = from) {
            const before = replies.length;
            await bot.handle({
                callback_query: { id: "test", from: sender, message: { message_id: id, chat }, data },
            });
            return replies[before];
        },
    };
}

test("Telegram AI sends the confirmed evidence once, then shows only the scoped diagnosis", async (context) => {
    const { db, monitor, foreign, projectId, userId, ops } = await setup(context);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-telegram-ai-"));
    const file = path.join(folder, "vault", "keys.json");
    const originalKeyFile = process.env.UPTIME_KUMA_PROJECT_KEY_FILE;
    process.env.UPTIME_KUMA_PROJECT_KEY_FILE = file;
    context.after(() => {
        if (originalKeyFile === undefined) {
            delete process.env.UPTIME_KUMA_PROJECT_KEY_FILE;
        } else {
            process.env.UPTIME_KUMA_PROJECT_KEY_FILE = originalKeyFile;
        }
        ai.setTestClient(undefined);
        fs.rmSync(file, { force: true });
        if (fs.existsSync(path.dirname(file))) {
            fs.rmdirSync(path.dirname(file));
        }
        fs.rmdirSync(folder);
    });
    const secret = "test-telegram-ai-credential";
    const input = [];
    let waiting;
    const { fakeClient, stream, completion, diagnosis } = require("../fixtures/openai-grant.cjs");
    const response = {
        ...diagnosis,
        facts: ["Тестовый ответ модели " + secret, ...Array(4).fill("🟢".repeat(180))],
    };
    ai.setTestClient(
        fakeClient(async (url, options) => {
            assert.equal(url, "https://api.openai.com/v1/responses");
            input.push(JSON.parse(options.body));
            if (waiting) {
                waiting.resolve(options.signal);
                await delay(30000, null, { signal: options.signal, ref: false });
                throw new Error("Expected the test request to be cancelled");
            }
            return stream([
                {
                    type: "response.completed",
                    response: completion({
                        output: [
                            { type: "message", content: [{ type: "output_text", text: JSON.stringify(response) }] },
                        ],
                    }),
                },
            ]);
        })
    );
    const chat = testChat({ telegramUserId }, ops);
    const landing = await chat.command("/ai");
    assert.match(landing.text, /Не подключён/);
    assert.match((await chat.command("/help")).text, /\/ai/);
    assert.match((await chat.press(`ai-prepare:${monitor}`)).text, /Администратору нужно/);
    await db("project_ai").insert({
        project_id: projectId,
        host_id: "telegram-test",
        mode: "api",
        model: "gpt-test",
        state: "verified",
        daily_limit: 1,
        allow_hosts: 1,
        allow_history: 0,
        secret_cipher: vaultModule.getVault().seal(projectId, { kind: "api", api_key: secret }),
    });
    const card = await chat.press(`monitor:${monitor}`);
    assert.ok(card.buttons.some(({ callback_data: data }) => data === `ai-check:${monitor}`));
    const overview = await chat.press(`ai-check:${monitor}`);
    assert.ok(overview.buttons.some(({ callback_data: data }) => data === `ai-prepare:${monitor}`));
    const prepare = `ai-prepare:${monitor}`;
    assert.equal(await chat.press(prepare, 7, { id: telegramUserId + 1, is_bot: false }), undefined);
    assert.match((await chat.press(`ai-prepare:${foreign}`)).text, /недоступны/);
    const old = await chat.press(prepare);
    assert.match(old.text, /HTTP 503/);
    assert.match(old.text, /Узел · example.com/);
    assert.doesNotMatch(old.text, /private-remote-error|password|signed|Сохранённые наблюдения|Название ·/);
    await db("heartbeat").where({ monitor_id: monitor, status: 0 }).update({ msg: "HTTP 502 changed-private-error" });
    assert.match((await chat.press(old.buttons[0].callback_data, old.id)).text, /Появились новые данные/);
    const fresh = await chat.press(prepare);
    const confirm = fresh.buttons[0].callback_data;
    assert.match((await chat.press(confirm, fresh.id + 1)).text, /Подтверждение устарело/);
    assert.equal(input.length, 0);
    assert.equal((await db("project_ai_job")).length, 0);
    const queued = await chat.press(confirm, fresh.id);
    assert.match(queued.text, /поставлен в очередь/);
    assert.match((await chat.press(confirm, fresh.id)).text, /Подтверждение устарело/);
    const [{ id: jobID, input_json: evidence }] = await db("project_ai_job");
    assert.equal(JSON.parse(evidence).latest.httpStatus, 502);
    assert.doesNotMatch(evidence, /changed-private-error|password|signed|Рабочий сайт|"observations"/);
    const jobRoute = queued.buttons[0].callback_data;
    assert.match((await chat.press(jobRoute)).text, /В очереди/);

    const worker = new ai.AIWorker();
    await worker.start();
    try {
        await worker.tick();
        await Promise.all([...worker.tasks]);
    } finally {
        await worker.stop();
    }
    assert.equal(input.length, 1);
    assert.ok(input[0].input[0].content.endsWith(evidence));
    const answer = await chat.press(jobRoute);
    assert.match(answer.text, /Тестовый ответ модели \[hidden\]/);
    assert.match(answer.text, /Показан краткий ответ/);
    assert.doesNotMatch(answer.text, new RegExp(secret));
    assert.ok(
        answer.buttons.some(
            ({ url }) => url === `https://panel.example/projects/${projectId}?section=ai&check=${monitor}`
        )
    );
    const next = await chat.press(prepare);
    assert.match((await chat.press(next.buttons[0].callback_data, next.id)).text, /суточный предел/);

    await db("project_ai").where({ project_id: projectId }).update({ daily_limit: 2 });
    const newPreview = await chat.press(prepare);
    const newQueued = await chat.press(newPreview.buttons[0].callback_data, newPreview.id);
    const newJobRoute = newQueued.buttons[0].callback_data;
    waiting = Promise.withResolvers();
    await worker.start();
    try {
        await worker.tick();
        const signal = await Promise.race([
            waiting.promise,
            delay(5000, null, { ref: false }).then(() => {
                throw new Error("The second diagnosis did not start");
            }),
        ]);
        assert.match((await chat.press(newJobRoute)).text, /Ожидание ответа модели/);
        assert.equal(await ai.cancelJob(userId, { projectID: projectId, id: jobID }, async () => {}), false);
        assert.equal(signal.aborted, false);
        const stop = (await chat.press(newJobRoute)).buttons.find(({ callback_data: data }) =>
            data?.startsWith("ai-stop:")
        );
        const stopPreview = await chat.press(stop.callback_data);
        assert.match((await chat.press(stopPreview.buttons[0].callback_data, stopPreview.id)).text, /отменён/);
        assert.equal(signal.aborted, true);
        await Promise.all([...worker.tasks]);
        assert.match((await chat.press(newJobRoute)).text, /Отменён/);
    } finally {
        await worker.stop();
    }
    await db("project_ai").where({ project_id: projectId }).increment("revision");
    assert.doesNotMatch((await chat.press(jobRoute)).text, /Тестовый ответ модели/);
    await db("project_member").where({ project_id: projectId, user_id: userId }).update({ role: "viewer" });
    assert.match((await chat.press(prepare)).text, /недоступны/);
    assert.ok((await chat.command("/ai")).buttons.some(({ callback_data: data }) => data === `ai-job:${jobID}`));
});

test("Telegram AI cancellation is confirmed, owner-bound and cannot stop another job", async (context) => {
    const { db, monitor, projectId, userId, ops } = await setup(context);
    await db("project_ai").insert({
        project_id: projectId,
        host_id: "telegram-test",
        mode: "api",
        model: "gpt-test",
        state: "verified",
        secret_cipher: "not-used-in-this-test",
    });
    const [otherUser] = await db("user").where("id", "<>", userId).select("id");
    const base = {
        project_id: projectId,
        project_revision: 1,
        revision: 1,
        monitor_id: monitor,
        kind: "diagnosis",
        trigger: "manual",
        status: "queued",
        user_id: userId,
        bucket_day: "2026-11-14",
        input_json: "{}",
        created_at: Date.now(),
        updated_at: Date.now(),
    };
    const [own] = await db("project_ai_job").insert(base);
    const [foreignActor] = await db("project_ai_job").insert({ ...base, user_id: otherUser.id });
    const [automatic] = await db("project_ai_job").insert({ ...base, trigger: "automatic" });
    const [recovery] = await db("project_ai_job").insert({ ...base, kind: "recovery" });
    const chat = testChat({ telegramUserId }, ops);
    for (const id of [foreignActor, automatic, recovery]) {
        assert.match((await chat.press(`ai-stop:${id}`)).text, /недоступен для отмены/);
    }
    assert.match((await chat.press(`ai-job:${recovery}`)).text, /недоступны/);
    const preview = await chat.press(`ai-stop:${own}`);
    assert.match(preview.text, new RegExp(`Запрос #${own}`));
    assert.equal((await db("project_ai_job").where({ id: own }).first()).status, "queued");
    assert.match((await chat.press(preview.buttons[0].callback_data, preview.id)).text, /отменён/);
    assert.doesNotMatch(
        (await chat.press(`ai-job:${own}`)).buttons.map((item) => item.callback_data).join(" "),
        /ai-stop/
    );
    assert.deepEqual(
        (await db("project_ai_job").orderBy("id").select("status")).map(({ status }) => status),
        ["cancelled", "queued", "queued", "queued"]
    );
    const [stale] = await db("project_ai_job").insert(base);
    const stalePreview = await chat.press(`ai-stop:${stale}`);
    await db("project_ai_job").where({ id: stale }).update({ status: "completed" });
    assert.match((await chat.press(stalePreview.buttons[0].callback_data, stalePreview.id)).text, /уже завершился/);
    assert.equal((await db("project_audit").where({ action: "aiJobCancelled" })).length, 1);
});

test("the poller acknowledges each batch offset and can abort a pending long request", async () => {
    const offsets = [];
    const call = async (method, body, signal) => {
        assert.equal(method, "getUpdates");
        offsets.push(body.offset);
        if (offsets.length === 1) {
            return [{ update_id: 35, message: { from: { id: 42 }, chat: { id: 42, type: "private" } } }];
        }
        await delay(60000, undefined, { signal });
    };
    const bot = new TelegramControlBot({ telegramUserId }, {}, call, () => {});
    const polling = bot.run();
    await new Promise((resolve) => setImmediate(resolve));
    bot.stop();
    await polling;
    assert.deepEqual(offsets, [0, 36]);
});

test("transport sends only to Telegram and removes secret URLs and response bodies from errors", async (context) => {
    const previousProxy = process.env.NOTIFICATION_PROXY;
    process.env.NOTIFICATION_PROXY = "socks5h://127.0.0.1:19080";
    context.after(() => {
        if (previousProxy === undefined) {
            delete process.env.NOTIFICATION_PROXY;
        } else {
            process.env.NOTIFICATION_PROXY = previousProxy;
        }
    });
    const post = context.mock.fn(async () => ({
        status: 429,
        data: { ok: false, parameters: { retry_after: 5 }, secret: token },
    }));
    const call = createTransport(token, { post });
    await assert.rejects(call("getUpdates", { timeout: 20 }), (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.retryAfter, 5000);
        assert.doesNotMatch(JSON.stringify(error), /123456789/);
        return true;
    });
    const [url, , options] = post.mock.calls[0].arguments;
    assert.equal(url, `https://api.telegram.org/bot${token}/getUpdates`);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.proxy, false);
    assert.equal(options.httpsAgent.constructor.name, "SocksProxyAgent");
    const broken = createTransport(token, {
        post: async () => {
            throw new Error(url);
        },
    });
    await assert.rejects(broken("getUpdates", {}), /^Error: Telegram request failed$/);
});

test("the private file selects exactly one credential source and requires numeric identities", (context) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-bot-config-"));
    const file = path.join(folder, "control.json");
    context.after(() => {
        fs.unlinkSync(file);
        fs.rmdirSync(folder);
    });
    const config = { version: 1, token, telegramUserId, userId: 1, projectId: 2 };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(readConfig(file), { token, telegramUserId, userId: 1, projectId: 2 });
    assert.throws(() => readConfig("control.json"), /Invalid Telegram control configuration/);
    fs.writeFileSync(file, JSON.stringify({ ...config, telegramUserId: "4815162342" }));
    assert.throws(() => readConfig(file), /Invalid Telegram control configuration/);
    const shared = { version: 1, notificationId: 3, botId: 123456789, telegramUserId, userId: 1, projectId: 2 };
    fs.writeFileSync(file, JSON.stringify(shared));
    assert.deepEqual(readConfig(file), {
        notificationId: shared.notificationId,
        botId: shared.botId,
        telegramUserId,
        userId: 1,
        projectId: 2,
    });
    for (const value of [
        { ...shared, token },
        { ...shared, botId: undefined },
        { ...shared, notificationId: "3" },
    ]) {
        fs.writeFileSync(file, JSON.stringify(value));
        assert.throws(() => readConfig(file), /Invalid Telegram control configuration/);
    }
    fs.writeFileSync(file, JSON.stringify(config));
    if (process.platform !== "win32") {
        fs.chmodSync(file, 0o644);
        assert.throws(() => readConfig(file), /Invalid Telegram control configuration/);
    }
});

/**
 * @param {object} context Test lifecycle
 * @param {object} fixture Isolated project and notification
 * @returns {Promise<object>} Encrypted channel fixture
 */
async function savedTelegram(context, fixture) {
    const vault = Object.create(vaultModule.ProjectVault.prototype);
    vault.ring = { active: "test", keys: { test: randomBytes(32).toString("base64") } };
    context.mock.method(vaultModule, "getVault", () => vault);
    const channel = {
        type: "telegram",
        managedDelivery: true,
        telegramBotToken: token,
        telegramChatID: String(telegramUserId),
        telegramServerUrl: "https://api.telegram.org",
    };
    await saveTelegram(fixture, channel);
    return channel;
}

/**
 * @param {object} fixture Isolated project and notification
 * @param {object} channel Settings for the test channel
 * @returns {Promise<void>} Saved encrypted settings
 */
async function saveTelegram(fixture, channel) {
    const { db, projectId, userId, notification } = fixture;
    const { protectNotificationConfig } = require("../../server/notification-config");
    const envelope = await protectNotificationConfig(channel, userId, null, db, projectId);
    await db("notification")
        .where({ id: notification })
        .update({ config: JSON.stringify(envelope) });
}

test("one bot sends existing alerts and opens the control menu using the encrypted channel", async (context) => {
    const { db, projectId, userId, notification } = await setup(context);
    const channel = await savedTelegram(context, { db, projectId, userId, notification });
    const post = context.mock.method(require("axios"), "post", async (url) => ({
        status: 200,
        data: { ok: true, result: url.endsWith("/getWebhookInfo") ? { url: "" } : { message_id: 7 } },
    }));
    const config = { projectId, userId, telegramUserId, botId: 123456789, notificationId: notification };
    const { operations, call } = controlConnection(config, {});
    const bot = new TelegramControlBot(config, operations, call, () => {});
    await new Telegram().send(channel, "Исходное уведомление");
    await bot.handle({
        message: {
            from: { id: telegramUserId, is_bot: false },
            chat: { type: "private", id: telegramUserId },
            text: "/start",
        },
    });
    assert.deepEqual(
        post.mock.calls.map(({ arguments: [url] }) => url.split("/").at(-1)),
        ["sendMessage", "getWebhookInfo", "sendMessage"]
    );
    for (const {
        arguments: [url],
    } of post.mock.calls) {
        assert.equal(url.split("/")[3], "bot" + token);
    }
    assert.equal(post.mock.calls[0].arguments[1].text, "Исходное уведомление");
    assert.match(post.mock.calls[2].arguments[1].text, /Telegram Test/);
    assert.equal((await db("notification").where({ id: notification }).first()).config.includes(token), false);
});

test("shared control rejects conflicting webhooks, foreign channels and changed recipients or bot identities", async (context) => {
    const { db, projectId, userId, monitor, notification } = await setup(context);
    const channel = await savedTelegram(context, { db, projectId, userId, notification });
    const sync = context.mock.fn(async () => {});
    let webhook = "https://example.com/other-receiver";
    const factory = context.mock.fn(() => async (method) => (method === "getWebhookInfo" ? { url: webhook } : []));
    const config = { projectId, userId, telegramUserId, botId: 123456789, notificationId: notification };
    const { operations, call } = controlConnection(config, { sync }, factory);
    await assert.rejects(call("getUpdates", {}), { status: 409 });
    webhook = "";
    assert.deepEqual(await call("getUpdates", {}), []);
    const prepared = await operations.prepare("pause", monitor);
    await db("project_ai").insert({
        project_id: projectId,
        host_id: "telegram-test",
        mode: "api",
        model: "gpt-test",
        state: "verified",
        secret_cipher: "unused",
    });
    const diagnosis = await operations.ai.prepare(monitor);

    await saveTelegram(
        { db, projectId, userId, notification },
        { ...channel, telegramChatID: String(telegramUserId + 1) }
    );
    await assert.rejects(operations.apply(prepared), /telegramControlChannelChanged/);
    await assert.rejects(operations.ai.enqueue(diagnosis), /telegramControlChannelChanged/);
    assert.equal((await db("project_ai_job")).length, 0);
    await db("notification").where({ id: notification }).update({ active: 0 });
    await assert.rejects(call("getUpdates", {}), /telegramControlChannelChanged/);
    await db("notification").where({ id: notification }).update({ active: 1 });
    await saveTelegram(
        { db, projectId, userId, notification },
        { ...channel, telegramBotToken: "987654321:" + "a".repeat(35) }
    );
    await assert.rejects(call("getUpdates", {}), /telegramControlChannelChanged/);
    await assert.rejects(
        controlConnection(config, { sync }, factory).call("getUpdates", {}),
        /telegramControlChannelChanged/
    );

    const rotated = "123456789:" + "b".repeat(35);
    await saveTelegram({ db, projectId, userId, notification }, { ...channel, telegramBotToken: rotated });
    await call("getUpdates", {});
    assert.equal(factory.mock.calls.at(-1).arguments[0], rotated);
    const otherOwner = (await db("user").where({ username: "other-owner" }).first()).id;
    await db("notification").where({ id: notification }).update({ user_id: otherOwner });
    await assert.rejects(operations.apply(prepared), /telegramControlChannelChanged/);
    assert.equal(sync.mock.callCount(), 0);
    assert.equal((await db("monitor").where({ id: monitor }).first()).active, 1);
});
