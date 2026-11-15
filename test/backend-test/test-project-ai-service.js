const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, guard } = require("../fixtures/project-workspace.cjs");
const { fakeClient, json, completion, stream, grant, clientID } = require("../fixtures/openai-grant.cjs");
const ai = require("../../server/projects/ai-service");
const store = require("../../server/projects/store");
const subscription = require("../../server/projects/subscription");
const { getVault, ProjectVault } = require("../../server/projects/vault");
const { readNotificationConfig, protectNotificationConfig } = require("../../server/notification-config");

/**
 * @param {number} projectID Project
 * @returns {Promise<object>} Configured, catalog-selected but unverified API connection
 */
async function configure(projectID) {
    const before = await ai.settings(1, projectID);
    let result = await ai.saveSettings(
        1,
        {
            ...before,
            projectID,
            mode: "api",
            apiKey: "synthetic-api-key-never-real",
            dailyLimit: 3,
            timeoutSeconds: 10,
            maxOutputTokens: 512,
        },
        guard
    );
    await ai.models(1, { projectID, revision: result.settings.revision }, guard);
    result = await ai.saveSettings(1, { ...result.settings, projectID, model: "gpt-synthetic" }, guard);
    return result.settings;
}
/**
 * @param {object} t Lifecycle
 * @returns {object} Counted local-only transport
 */
function transport(t) {
    const sent = [];
    const client = fakeClient((url, options) => {
        sent.push({ url, options });
        if (url.endsWith("/models")) {
            return json({ data: [{ id: "gpt-synthetic" }] });
        }
        if (url.endsWith("/responses")) {
            return stream([{ type: "response.completed", response: completion() }]);
        }
        throw new Error("Unexpected local test endpoint");
    });
    ai.setTestClient(client);
    t.after(() => ai.setTestClient(undefined));
    return { sent, client };
}
/**
 * @param {object} worker Test-owned queue
 * @returns {Promise<void>} Finish the claimed one-shot job
 */
async function settle(worker) {
    await worker.tick();
    await Promise.allSettled([...worker.tasks]);
}

test("credentials are encrypted per project, notification envelopes bind owners, and key rotation retains recovery keys", async (t) => {
    const { db, projectID, otherID, folder } = await fixture(t);
    transport(t);
    await configure(projectID);
    const row = await db("project_ai").where({ project_id: projectID }).first();
    assert.equal(row.secret_cipher.includes("synthetic-api-key"), false);
    const vault = getVault();
    const old = row.secret_cipher;
    assert.throws(() => vault.open(otherID, old), /projectKeyMissing/);
    assert.throws(() => vault.open(projectID, old, "notification"), /projectKeyMissing/);
    const owner = (await db("project").where({ id: projectID }).first()).data_user_id;
    const config = await protectNotificationConfig(
        { type: "smtp", name: "Mail", smtpPassword: "synthetic-mail-password", managedDelivery: true },
        owner,
        null,
        db,
        projectID
    );
    assert.equal(JSON.stringify(config).includes("synthetic-mail-password"), false);
    await db("notification").insert({ user_id: owner, name: "Mail", config: JSON.stringify(config) });
    const channel = await db("notification").first();
    assert.equal(readNotificationConfig(channel).smtpPassword, "synthetic-mail-password");
    assert.throws(() => readNotificationConfig({ ...channel, user_id: 2 }), /projectKeyMissing/);
    assert.throws(() => readNotificationConfig(channel.config), /projectKeyMissing/);
    await vault.rotate(db);
    assert.notEqual((await db("project_ai").where({ project_id: projectID }).first()).secret_cipher, old);
    assert.equal(vault.open(projectID, old).api_key, "synthetic-api-key-never-real");
    assert.equal(readNotificationConfig(await db("notification").first()).smtpPassword, "synthetic-mail-password");
    const reopened = new ProjectVault(path.join(folder, "vault", "keys.json"), true);
    assert.equal(reopened.open(projectID, old).api_key, "synthetic-api-key-never-real");
    assert.throws(() => new ProjectVault(path.join(folder, "lost-vault", "keys.json"), true), /projectKeyMissing/);
    assert.equal(fs.existsSync(path.join(folder, "lost-vault", "keys.json")), false);
});

test("saving settings and selecting a model do not run inference; only a completed explicit probe verifies access", async (t) => {
    const { db, projectID, ids } = await fixture(t);
    const { sent } = transport(t);
    const settings = await configure(projectID);
    assert.equal(sent.filter((entry) => entry.url.endsWith("/responses")).length, 0);
    assert.equal(settings.state, "saved");
    assert.equal(JSON.stringify(await ai.settings(1, projectID)).includes("synthetic-api-key"), false);
    await assert.rejects(ai.settings(ids.viewer, projectID), /projectAccessDenied/);
    await assert.rejects(ai.enqueue(ids.operator, { projectID, kind: "probe", revision: settings.revision }, guard));
    const jobID = await ai.enqueue(1, { projectID, kind: "probe", revision: settings.revision }, guard);
    await assert.rejects(
        ai.enqueue(1, { projectID, kind: "probe", revision: settings.revision }, guard),
        /projectAIBusy/
    );
    const worker = new ai.AIWorker();
    await worker.start();
    t.after(() => worker.stop());
    await settle(worker);
    assert.equal((await db("project_ai_job").where({ id: jobID }).first()).status, "completed");
    assert.equal((await ai.settings(1, projectID)).state, "verified");
    assert.equal(sent.filter((entry) => entry.url.endsWith("/responses")).length, 1);
});

test("personal workspace guided channels are encrypted before login serialization and remain owner-bound", async (t) => {
    const { db } = await fixture(t);
    const config = {
        managedDelivery: true,
        type: "smtp",
        name: "Synthetic personal mail",
        smtpPassword: "synthetic-personal-secret",
    };
    await db("notification").insert({ user_id: 1, name: config.name, config: JSON.stringify(config) });
    await store.ensurePersonalProject(1);
    const channel = await db("notification").where({ user_id: 1 }).first();
    assert.equal(channel.config.includes(config.smtpPassword), false);
    assert.equal(readNotificationConfig(channel).smtpPassword, config.smtpPassword);
    assert.throws(() => readNotificationConfig({ ...channel, user_id: 2 }), /projectKeyMissing/);
    await store.ensurePersonalProject(1);
    assert.equal((await db("notification").where({ id: channel.id }).first()).config, channel.config);
});

test("personal channel encryption keeps private SMTP blocked until explicitly approved and never reports an unstarted send uncertain", async (t) => {
    const { db } = await fixture(t);
    await store.ensurePersonalProject(1);
    const personal = await db("project").where({ data_user_id: 1 }).first();
    const delivery = require("../../server/notification-delivery");
    const channelID = await delivery.saveManagedChannel(
        1,
        {
            monitorIDs: [],
            config: {
                type: "smtp",
                name: "Synthetic private mail",
                smtpHost: "127.0.0.1",
                smtpPort: 465,
                smtpSecure: true,
                smtpUsername: "synthetic",
                smtpPassword: "synthetic-mail",
                smtpFrom: "from@example.test",
                smtpTo: "to@example.test",
                locale: "en",
            },
        },
        guard
    );
    let sends = 0;
    let now = Date.now();
    const queue = new delivery.DeliveryQueue({
        db,
        now: () => now,
        send: async () => {
            sends++;
        },
    });
    const first = await queue.enqueue(1, channelID, "test", "Synthetic test", "test-private-blocked", null, 1, guard);
    await queue.tick();
    assert.equal(sends, 0);
    const blocked = await db("notification_delivery").where({ id: first }).first();
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.error_code, "target");
    await db("project").where({ id: personal.id }).update({ allowed_ips_json: '["127.0.0.1"]' });
    now += 31000;
    const second = await queue.enqueue(1, channelID, "test", "Synthetic test", "test-private-approved", null, 1, guard);
    await queue.tick();
    assert.equal(sends, 1);
    assert.equal((await db("notification_delivery").where({ id: second }).first()).status, "submitted");
});

test("diagnosis uses the exact consented safe evidence, honors daily limits and cancels after changed rights", async (t) => {
    const { db, projectID, monitorID, ids } = await fixture(t);
    const { sent } = transport(t);
    const settings = await configure(projectID);
    await db("project_ai").where({ project_id: projectID }).update({ state: "verified" });
    const beat = {
        monitor_id: monitorID,
        time: new Date().toISOString(),
        status: 0,
        ping: 42,
        msg: "HTTP 404 bearer-secret-should-never-share",
        response: "secret-response",
        check_interval: 20,
        check_session: "run",
    };
    await db("heartbeat").insert(beat);
    const preview = await ai.prepare(ids.operator, { projectID, monitorID });
    assert.deepEqual(preview.evidence.failure, { category: "http_not_found", httpStatus: 404 });
    const output = JSON.stringify(preview);
    for (const secret of ["never-share", "bearer-secret", "secret-response", "Synthetic service", "127.0.0.1"]) {
        assert.equal(output.includes(secret), false, secret);
    }
    await assert.rejects(ai.prepare(ids.viewer, { projectID, monitorID }));
    await assert.rejects(
        ai.enqueue(
            ids.operator,
            { projectID, monitorID, kind: "diagnosis", revision: settings.revision, evidenceHash: "stale" },
            guard
        ),
        /projectAIEvidenceChanged/
    );
    const jobID = await ai.enqueue(
        ids.operator,
        { projectID, monitorID, kind: "diagnosis", revision: settings.revision, evidenceHash: preview.hash },
        guard
    );
    const scope = await require("../../server/projects/access").permit(1, projectID, "admin");
    await store.changeMember(1, { projectID, userID: ids.operator, role: "viewer", revision: scope.revision }, guard);
    const worker = new ai.AIWorker();
    await worker.start();
    t.after(() => worker.stop());
    await settle(worker);
    assert.equal((await db("project_ai_job").where({ id: jobID }).first()).status, "cancelled");
    assert.equal(sent.filter((entry) => entry.url.endsWith("/responses")).length, 0);
    await db("project_ai").where({ project_id: projectID }).update({ daily_limit: 1 });
    await assert.rejects(
        ai.enqueue(1, { projectID, kind: "probe", revision: settings.revision }, guard),
        /projectAIDailyLimit/
    );
});

test("unfinished paid work is uncertain, is not replayed on restart, and queued cancellation never sends it", async (t) => {
    const { db, projectID } = await fixture(t);
    const { client, sent } = transport(t);
    const settings = await configure(projectID);
    client.diagnose = async () => {
        sent.push({ url: "paid-attempt" });
        throw new (require("../../server/projects/openai-client").AIError)("incomplete");
    };
    const jobID = await ai.enqueue(1, { projectID, kind: "probe", revision: settings.revision }, guard);
    const worker = new ai.AIWorker();
    await worker.start();
    await settle(worker);
    assert.equal((await db("project_ai_job").where({ id: jobID }).first()).status, "uncertain");
    await worker.stop();
    await worker.start();
    await settle(worker);
    assert.equal(sent.filter((entry) => entry.url === "paid-attempt").length, 1);
    const next = await ai.enqueue(1, { projectID, kind: "probe", revision: settings.revision }, guard);
    await ai.cancelJob(1, { projectID, id: next }, guard);
    await settle(worker);
    assert.equal(sent.filter((entry) => entry.url === "paid-attempt").length, 1);
    await worker.stop();
});

test("pairing is single-use, signed and bound to project, actor, nonce, revision and issued client", async (t) => {
    const { db, projectID, otherID, ids } = await fixture(t);
    const { client } = transport(t);
    const before = await ai.settings(1, projectID);
    const result = await ai.saveSettings(1, { ...before, projectID, mode: "subscription" }, guard);
    const request = { projectID, revision: result.settings.revision };
    await assert.rejects(subscription.begin(ids.viewer, request, guard, "https://app.example.test"));
    assert.throws(() => subscription.transferOrigin("http://remote.example.test"));
    const pairing = await subscription.begin(1, request, guard, "https://app.example.test");
    assert.equal(JSON.stringify(await db("project_oauth_pairing")).includes(pairing.token), false);
    const identity = require("../fixtures/openai-grant.cjs").identity;
    await assert.rejects(
        subscription.complete(pairing.pairingID, pairing.token, { ...grant(), client_id: clientID }),
        /auth/
    );
    await assert.rejects(
        subscription.complete(pairing.pairingID, pairing.token, {
            ...grant({ id_token: identity({ nonce: pairing.nonce }) }),
            client_id: "dynamic_agent_client",
        })
    );
    await subscription.complete(pairing.pairingID, pairing.token, {
        ...grant({ id_token: identity({ nonce: pairing.nonce }) }),
        client_id: clientID,
    });
    assert.equal((await ai.settings(1, projectID)).state, "saved");
    assert.equal((await ai.settings(1, projectID)).hasSecret, true);
    await assert.rejects(subscription.complete(pairing.pairingID, pairing.token, { ...grant(), client_id: clientID }));
    const row = await db("project_ai").where({ project_id: projectID }).first();
    assert.throws(() => getVault().open(otherID, row.secret_cipher));
    const second = await subscription.begin(
        1,
        { projectID, revision: row.revision },
        guard,
        "https://app.example.test"
    );
    assert.equal(second.clientID, clientID);
    const project = await db("project").where({ id: projectID }).first();
    await store.updateProject(1, { projectID, revision: project.revision, name: "Changed", timezone: "UTC" }, guard);
    await assert.rejects(subscription.pairing(second.pairingID, second.token));
    assert.equal(client instanceof require("../../server/projects/openai-client").OpenAIClient, true);
});

test("refresh does not run before the provider's earliest permitted time", async (t) => {
    const { db, projectID } = await fixture(t);
    transport(t);
    const row = await db("project_ai").where({ project_id: projectID }).first();
    const secret = {
        kind: "subscription",
        access_token: "synthetic-access",
        expires_at: Date.now() + 30000,
        earliest_refresh_at: Math.floor(Date.now() / 1000) + 120,
    };
    row.mode = "subscription";
    row.secret_cipher = getVault().seal(projectID, secret);
    assert.equal(await ai.bearer(row, AbortSignal.timeout(5000)), secret.access_token);
});

test("AI evidence does not label a healthy check unreachable and respects paused parent groups", async (t) => {
    const { db, projectID, monitorID, ids } = await fixture(t);
    await db("heartbeat").insert({ monitor_id: monitorID, time: new Date().toISOString(), status: 1, ping: 5 });
    const healthy = await ai.prepare(ids.operator, { projectID, monitorID });
    assert.equal(healthy.evidence.state, "up");
    assert.equal(healthy.evidence.reason, null);
    assert.equal(healthy.evidence.failure, null);
    const child = await db("monitor").where({ id: monitorID }).first();
    const [parentID] = await db("monitor").insert({
        user_id: child.user_id,
        name: "Paused group",
        type: "group",
        active: 0,
    });
    await db("monitor").where({ id: monitorID }).update({ parent: parentID });
    const paused = await ai.prepare(ids.operator, { projectID, monitorID });
    assert.equal(paused.evidence.state, "paused");
});

test("AI evidence explains UTC and units, retains the actual HTTP code and typed work, and excludes raw errors", () => {
    const now = Date.now();
    const monitor = {
        id: 14,
        type: "http",
        active: 1,
        interval: 20,
        name: "private-name",
        url: "https://owner:private-password@example.test/?token=private-query",
    };
    const work = {
        kind: "update",
        phase: "verifying",
        startedAt: now - 120000,
        deadline: now + 60000,
        runID: "a".repeat(64),
    };
    const beats = [3, 2, 0, 0].map((status, index) => ({
        time: new Date(now - (3 - index) * 20000).toISOString().replace("T", " ").replace("Z", ""),
        status,
        ping: status === 3 ? null : 5,
        check_interval: 20,
        check_session: "same-run",
        msg:
            status === 3
                ? require("../../src/site-work.ts").workMessage(work)
                : "Request failed with status code 503 private-error",
    }));
    const evidence = ai.evidenceFor({ allow_names: 0, allow_hosts: 0, allow_history: 1 }, monitor, beats);
    assert.equal(evidence.semantics.timezone, "UTC");
    assert.deepEqual(evidence.semantics.units, {
        ping: "milliseconds",
        interval: "seconds",
        responseLimitMs: "milliseconds",
    });
    assert.match(evidence.semantics.statuses[3], /planned work/);
    assert.match(evidence.semantics.statuses[2], /unconfirmed/);
    assert.equal(evidence.latest.time, new Date(now).toISOString());
    assert.equal(evidence.latest.httpStatus, 503);
    assert.deepEqual(evidence.failure, { category: "http_server_error", httpStatus: 503 });
    assert.deepEqual(evidence.observations[0].work, { kind: "update", phase: "verifying" });
    for (const secret of [
        "private-name",
        "private-password",
        "private-query",
        "private-error",
        "same-run",
        "example.test",
    ])
        assert.equal(JSON.stringify(evidence).includes(secret), false);
    const minimal = ai.evidenceFor({ allow_names: 0, allow_hosts: 0, allow_history: 0 }, monitor, beats);
    assert.equal(Object.hasOwn(minimal, "observations"), false);
});

test("unrelated numbers and non-HTTP failures are never presented as an observed HTTP status", () => {
    const monitor = { id: 14, type: "http", active: 1, interval: 20 };
    const beat = { time: new Date().toISOString(), status: 0, ping: null };
    for (const msg of ["SMTP 503", "HTTP 600", "status code 99", "token=503", "service 503", "HTTP 5030"]) {
        const evidence = ai.evidenceFor({}, monitor, [{ ...beat, msg }]);
        assert.equal(Object.hasOwn(evidence.latest, "httpStatus"), false, msg);
    }
    const port = ai.evidenceFor({}, { ...monitor, type: "port" }, [{ ...beat, msg: "HTTP 503" }]);
    assert.equal(Object.hasOwn(port.latest, "httpStatus"), false);
});

test("a queued settings save cannot revoke a subscription after its administrator loses access", async (t) => {
    const { db, projectID, ids } = await fixture(t);
    const { client } = transport(t);
    const secret = getVault().seal(projectID, { kind: "subscription", refresh_token: "synthetic-refresh" });
    await db("project_ai").where({ project_id: projectID }).update({ mode: "subscription", secret_cipher: secret });
    const before = await ai.settings(ids.admin, projectID);
    let revocations = 0;
    client.revoke = async () => {
        revocations++;
        return true;
    };
    let release;
    let entered;
    const enteredLock = new Promise((resolve) => (entered = resolve));
    const blocked = ai.locked(projectID, async () => {
        entered();
        await new Promise((resolve) => (release = resolve));
    });
    await enteredLock;
    let started;
    const startedSave = new Promise((resolve) => (started = resolve));
    const attempt = ai.saveSettings(ids.admin, { ...before, projectID, mode: "off" }, async () => started());
    const rejected = assert.rejects(attempt, /projectAccessDenied/);
    await startedSave;
    try {
        const project = await db("project").where({ id: projectID }).first();
        await store.changeMember(
            1,
            { projectID, userID: ids.admin, role: "viewer", revision: project.revision },
            guard
        );
    } finally {
        release();
    }
    await blocked;
    await rejected;
    const after = await db("project_ai").where({ project_id: projectID }).first();
    assert.equal(revocations, 0);
    assert.equal(after.mode, "subscription");
    assert.equal(after.secret_cipher, secret);
    assert.equal(after.revision, before.revision);
});
