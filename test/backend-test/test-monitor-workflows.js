const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");
const { chromium } = require("playwright-core");
const { fixture, guard } = require("../fixtures/project-workspace.cjs");
const { DeliveryQueue, saveManagedChannel } = require("../../server/notification-delivery");
const escalation = require("../../server/notification-escalation");
const witness = require("../../server/independent-witness");
const { targetHash, siteResult } = require("../../server/witness-sites");
const { readVerification } = require("../../server/monitor-verification");
const { ProjectNetworkPolicy } = require("../../server/projects/network-policy");
const { runJourney, stepsFrom } = require("../../server/monitor-types/browser-journey");
const { RealBrowserMonitorType } = require("../../server/monitor-types/real-browser-monitor-type");
const { Settings } = require("../../server/settings");
const { RemoteBrowser } = require("../../server/remote-browser");
const { TelegramControlBot } = require("../../server/telegram-control/bot");

/**
 * @param {object} t Node test fixture
 * @param {Function} handler Loopback-only HTTP response
 * @returns {Promise<string>} Test server origin
 */
async function localServer(t, handler) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return "http://127.0.0.1:" + server.address().port;
}

test("selected Telegram alerts can be acknowledged, and unacknowledged alerts send one email", async (t) => {
    const { db, projectID, monitorID, folder } = await fixture(t);
    const owner = (await db("project").where({ id: projectID }).first()).data_user_id;
    const telegram = await saveManagedChannel(
        owner,
        {
            config: {
                type: "telegram",
                name: "Private channel",
                telegramBotToken: "123456:" + "a".repeat(32),
                telegramChatID: "345678",
                locale: "ru",
            },
            monitorIDs: [monitorID],
        },
        guard,
        projectID
    );
    const email = await saveManagedChannel(
        owner,
        {
            config: {
                type: "smtp",
                name: "Reserve",
                smtpHost: "127.0.0.1",
                smtpPort: 465,
                smtpSecure: true,
                smtpFrom: "from@example.test",
                smtpTo: "to@example.test",
            },
            monitorIDs: [],
        },
        guard,
        projectID
    );
    const configPath = path.join(folder, "telegram.json");
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            version: 1,
            projectId: projectID,
            userId: 1,
            notificationId: telegram,
            telegramUserId: 345678,
            botId: 123456,
        }),
        { mode: 0o600 }
    );
    t.mock.method(Date, "now", () => now);
    const previous = process.env.UPTIME_KUMA_TELEGRAM_CONTROL_CONFIG;
    process.env.UPTIME_KUMA_TELEGRAM_CONTROL_CONFIG = configPath;
    t.after(() => {
        if (previous === undefined) {
            delete process.env.UPTIME_KUMA_TELEGRAM_CONTROL_CONFIG;
        } else {
            process.env.UPTIME_KUMA_TELEGRAM_CONTROL_CONFIG = previous;
        }
    });
    let now = new Date("2026-11-16T12:00:00Z").getTime();
    const rule = { monitorID, telegramID: telegram, emailID: email, enabled: true };
    await assert.rejects(escalation.saveRule(owner, rule, guard, projectID), /criticalAlertChannels/);
    await db("notification_delivery").insert({
        user_id: owner,
        notification_id: email,
        revision: 1,
        kind: "test",
        status: "submitted",
        event_key: "fixture-proven",
        confirmed_at: now,
        created_at: now,
        updated_at: now,
        next_attempt_at: now,
        payload: "Synthetic test",
        attempts: 1,
    });
    await escalation.saveRule(owner, rule, guard, projectID);
    assert.deepEqual(await escalation.rulesForOwner(owner), [{ monitorID, telegramID: telegram, emailID: email }]);
    const sent = [];
    let failure = null;
    const queue = new DeliveryQueue({
        db,
        now: () => now,
        isUnderMaintenance: async () => false,
        send: async (config) => {
            sent.push({ type: config.type, token: config.telegramAlertToken });
            if (config.type === "telegram" && failure) {
                throw Object.assign(new Error("fixture failure"), { response: { status: failure } });
            }
        },
    });
    const enqueue = async (key) => {
        await db("heartbeat").insert({
            monitor_id: monitorID,
            time: new Date(now).toISOString(),
            status: 0,
            msg: "HTTP 503",
        });
        return queue.enqueue(owner, telegram, "down", "Synthetic fault", key, monitorID);
    };
    const ack = async () => ({ data_user_id: owner });
    const first = await enqueue("sample:1");
    await queue.processOne();
    assert.match(sent[0].token, /^[a-zA-Z0-9_-]{22}$/);
    assert.equal(await escalation.acknowledge(ack, email, sent[0].token, now), false);
    const replies = [];
    const bot = new TelegramControlBot(
        { telegramUserId: 345678 },
        { acknowledgeAlert: (token) => escalation.acknowledge(ack, telegram, token, now) },
        async (method, body) => replies.push({ method, body }),
        () => {}
    );
    const click = {
        id: "test-query",
        data: "alert:" + sent[0].token,
        from: { id: 345678, is_bot: false },
        message: { message_id: 50, chat: { id: 345678, type: "private" } },
    };
    await bot.handle({ callback_query: { ...click, from: { id: 444444, is_bot: false } } });
    assert.equal(replies.length, 0);
    await bot.handle({ callback_query: click });
    assert.deepEqual(
        replies.map(({ method }) => method),
        ["answerCallbackQuery", "editMessageReplyMarkup"]
    );
    assert.equal(replies[0].body.text, "Принято");
    assert.equal(await escalation.acknowledge(ack, telegram, sent[0].token, now + 9), true);
    assert.equal(Number((await db("notification_delivery").where({ id: first }).first()).confirmed_at), now);
    now += escalation.waitTime;
    await queue.processOne();
    assert.deepEqual(
        sent.map((item) => item.type),
        ["telegram"]
    );

    await enqueue("sample:2");
    await queue.processOne();
    now += escalation.waitTime - 1;
    await enqueue("sample:late-event");
    await db("notification_delivery").where({ event_key: "sample:late-event" }).update({ status: "cancelled" });
    await queue.processOne();
    assert.deepEqual(
        sent.map((item) => item.type),
        ["telegram", "telegram"]
    );
    now++;
    await queue.processOne();
    await queue.processOne();
    assert.deepEqual(
        sent.map((item) => item.type),
        ["telegram", "telegram", "smtp"]
    );

    failure = 404;
    await enqueue("sample:3");
    await queue.processOne();
    await queue.processOne();
    await queue.processOne();
    assert.deepEqual(
        sent.map((item) => item.type),
        ["telegram", "telegram", "smtp", "telegram", "smtp"]
    );
});

test("witness only retains signed, fresh results for the exact opted-in address", async (t) => {
    const { db, monitorID } = await fixture(t);
    const monitor = await db("monitor").where({ id: monitorID }).first();
    await db("monitor").where({ id: monitorID }).update({ witness_site: true });
    monitor.witness_site = true;
    const config = {
        nodeID: "synthetic-witness",
        label: "Probe",
        secret: Buffer.alloc(32, 21).toString("base64url"),
        hash: "0".repeat(64),
    };
    const stamp = Date.now();
    const value = {
        nodeID: config.nodeID,
        timestamp: stamp,
        nonce: Buffer.alloc(32, 11).toString("base64url"),
        channels: [],
        sites: [{ id: monitorID, hash: targetHash(monitor.url), checkedAt: stamp, httpStatus: 503, responseMS: 12 }],
    };
    value.signature = witness.sign(config, witness.requestText(value));
    const changed = { ...value, sites: [{ ...value.sites[0], httpStatus: 200 }] };
    assert.equal(witness.valid(changed, config), false);
    await witness.accept(value, config, db);
    await assert.rejects(witness.accept(value, config, db));
    assert.equal((await siteResult(monitor, config)).state, "down");
    assert.equal((await siteResult({ ...monitor, url: "https://example.org/" }, config)).state, "missing");
    await assert.rejects(readVerification(2, monitorID), /verificationUnavailable/);
});

test(
    "browser journeys reject open-ended steps and preserve the step that failed",
    {
        skip: !fs.existsSync(chromium.executablePath()),
    },
    async (t) => {
        assert.throws(() => stepsFrom([{ action: "script", text: "alert()" }]), /browserJourneyInvalid/);
        let outside = 0;
        let posts = 0;
        const otherOrigin = await localServer(t, (_request, response) => {
            outside++;
            response.end();
        });
        const origin = await localServer(t, (request, response) => {
            posts += request.method === "POST" ? 1 : 0;
            response.setHeader("Content-Type", "text/html");
            response.end(`<!doctype html><button onclick="this.nextElementSibling.hidden = false">Open catalog</button>
            <p hidden>Catalog is visible</p>
            <img src="${otherOrigin}/outside">
            <script>fetch("/submit",{method:"POST"}).catch(()=>{});</script>`);
        });
        const browser = await chromium.launch();
        t.after(() => browser.close());
        const monitor = { type: "real-browser", interval: 6, url: origin, browser_steps_json: "" };
        const policy = new ProjectNetworkPolicy(["127.0.0.1"]);
        const first = [
            { action: "click", text: "Open catalog" },
            { action: "visible", text: "Catalog is visible" },
        ];
        monitor.browser_steps_json = JSON.stringify(first);
        assert.equal((await runJourney(browser, monitor, policy)).failedStep, null);
        monitor.browser_steps_json = JSON.stringify([...first, { action: "visible", text: "Impossible text" }]);
        const { db, monitorID } = await fixture(t);
        await db("monitor").where({ id: monitorID }).update({
            type: monitor.type,
            url: monitor.url,
            interval: monitor.interval,
            browser_steps_json: monitor.browser_steps_json,
        });
        const saved = await db("monitor").where({ id: monitorID }).first();
        let closed = false;
        t.mock.method(Settings, "get", async () => "#playwright_chromium");
        t.mock.method(RemoteBrowser, "get", async () => ({ url: "ws://127.0.0.1:1", name: "Fixture" }));
        t.mock.method(chromium, "connect", async () => ({
            isConnected: () => true,
            newContext: async () => {
                throw new Error("Remote fixture refused the context");
            },
            close: async () => {
                closed = true;
            },
        }));
        t.mock.method(chromium, "launch", async () => browser);
        const service = new RealBrowserMonitorType();
        await assert.rejects(
            service.check({ ...saved, browser_steps_json: null, remote_browser: 1 }, {}, {}),
            /Remote fixture refused the context/
        );
        assert.equal(closed, true);
        await assert.rejects(service.check(saved, {}, {}), /Browser step 3 failed/);
        const failure = (await readVerification(saved.user_id, monitorID, true)).journey;
        assert.equal(failure.failedStep, 3);
        const brief = await readVerification(saved.user_id, monitorID);
        assert.equal(brief.journey.hasScreenshot, true);
        assert.equal(brief.journey.screenshot, null);
        assert.equal((await readVerification(saved.user_id, monitorID, true)).journey.screenshot, failure.screenshot);
        await assert.rejects(readVerification(2, monitorID, true), /verificationUnavailable/);
        assert.ok(failure.screenshot?.startsWith("/9j/"));
        assert.equal(outside, 0);
        assert.equal(posts, 0);
    }
);
