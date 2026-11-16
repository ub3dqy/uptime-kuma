const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validatedWork, workMessage, workFromBeat, workLabel } = require("../../src/site-work.ts");
const { signalForMonitor } = require("../../server/site-work");
const { monitorMessage } = require("../../server/notification-delivery");
const { safeBeat } = require("../../server/projects/store");
const { incidentEvidence } = require("../../src/incident-state.ts");
const now = Date.parse("2026-11-02T20:30:00Z");
const work = {
    kind: "update",
    phase: "verifying",
    startedAt: now - 60000,
    deadline: now + 120000,
    runID: "a".repeat(64),
};
const monitor = {
    id: 9,
    user_id: 1,
    active: 1,
    interval: 60,
    url: "https://owner:secret@example.test/health?token=secret",
    name: "Owned site",
};

/**
 * @param {object} envelope Synthetic local observation
 * @param {number} mode Permissions
 * @returns {string} Isolated test file
 */
function observation(envelope, mode = 0o600) {
    const directory = path.resolve("private", "site-work-test-" + randomUUID());
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 });
    const filename = path.join(directory, "site-work.json");
    fs.writeFileSync(filename, JSON.stringify(envelope), { mode });
    return filename;
}
const record = (extra = {}) => ({
    monitorID: 9,
    ownerID: 1,
    host: "example.test",
    observedAt: now,
    state: "active",
    work,
    ...extra,
});

test("only a real maintenance observation can carry a typed work reason", () => {
    const message = workMessage(work);
    assert.deepEqual(workFromBeat({ status: 3, msg: message }), work);
    for (const status of [0, 1, 2, undefined]) assert.equal(workFromBeat({ status, msg: message }), null);
    for (const invalid of [
        null,
        {},
        { ...work, kind: "server hacked" },
        { ...work, phase: "<script>" },
        { ...work, deadline: now + 86400000 },
        { ...work, startedAt: Number.MAX_SAFE_INTEGER - 1000, deadline: Number.MAX_SAFE_INTEGER },
        { ...work, startedAt: "1" },
        { ...work, runID: "secret" },
    ]) {
        assert.equal(validatedWork(invalid), null);
        assert.throws(() => workMessage(invalid));
    }
    assert.equal(workFromBeat({ status: 3, msg: message + ":extra" }), null);
    assert.equal(workLabel({ status: 3, msg: message }), "siteWorkKind_update");
});

test("work signal is check-, owner- and hostname-specific, fresh and bounded", async () => {
    const filename = observation({ version: 1, records: [record()] });
    assert.equal((await signalForMonitor(monitor, now, filename)).state, "active");
    assert.equal(
        (
            await signalForMonitor(
                monitor,
                work.deadline,
                observation({ version: 1, records: [record({ observedAt: work.deadline })] })
            )
        ).state,
        "overdue"
    );
    for (const row of [
        record({ monitorID: 8 }),
        record({ ownerID: 2 }),
        record({ host: "other.test" }),
        record({ observedAt: now - 45001 }),
        record({ observedAt: now + 5001 }),
        record({ state: "unavailable" }),
        record({ work: { ...work, startedAt: now + 1000 } }),
    ]) {
        assert.equal(await signalForMonitor(monitor, now, observation({ version: 1, records: [row] })), null);
    }
    for (const envelope of [
        { version: 2, records: [record()] },
        { version: 1, records: [record(), record()] },
        { version: 1, records: new Array(201).fill(record()) },
    ]) {
        assert.equal(await signalForMonitor(monitor, now, observation(envelope)), null);
    }
    assert.equal(
        (
            await signalForMonitor(
                monitor,
                now,
                observation({ version: 1, records: [record({ state: "idle", work: undefined })] })
            )
        ).state,
        "idle"
    );
    assert.equal(await signalForMonitor(monitor, now, filename + ".missing"), null);
});

test(
    "unsafe signal files cannot suppress monitoring",
    { skip: process.platform === "win32" ? "Linux permission and link checks run in the isolated Linux gate" : false },
    async () => {
        assert.equal(
            await signalForMonitor(monitor, now, observation({ version: 1, records: [record()] }, 0o644)),
            null
        );
        const filename = observation({ version: 1, records: [record()] });
        fs.linkSync(filename, filename + ".hard");
        assert.equal(await signalForMonitor(monitor, now, filename), null);
        fs.symlinkSync(filename, filename + ".link");
        assert.equal(await signalForMonitor(monitor, now, filename + ".link"), null);
    }
);

test("the common monitor and recovery gate opens again after source loss or deadline expiry", async (context) => {
    const { R } = require("redbean-node");
    const Dialect = require("knex/lib/dialects/sqlite3");
    Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
    const db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
    R.setup(db);
    const Database = require("../../server/database");
    const previous = Database.dataDir;
    context.after(async () => {
        Database.dataDir = previous;
        await db.destroy();
    });
    await db.schema.createTable("monitor", (t) => {
        t.integer("id").primary();
        t.integer("user_id");
        t.text("url");
        t.integer("parent");
    });
    await db.schema.createTable("monitor_maintenance", (t) => {
        t.integer("monitor_id");
        t.integer("maintenance_id");
    });
    await db("monitor").insert({ id: 9, user_id: 1, url: monitor.url });
    const current = Date.now();
    const liveWork = { ...work, startedAt: current - 60000, deadline: current + 60000 };
    const filename = observation({ version: 1, records: [record({ observedAt: current, work: liveWork })] });
    Database.dataDir = path.dirname(filename);
    const Monitor = require("../../server/model/monitor");
    assert.equal(await Monitor.isUnderMaintenance(9), true);
    fs.writeFileSync(
        filename,
        JSON.stringify({ version: 1, records: [record({ observedAt: current - 45001, work: liveWork })] })
    );
    assert.equal(await Monitor.isUnderMaintenance(9), false);
    fs.writeFileSync(
        filename,
        JSON.stringify({
            version: 1,
            records: [record({ observedAt: current, work: { ...liveWork, deadline: current - 1 } })],
        })
    );
    assert.equal(await Monitor.isUnderMaintenance(9), false);
});

test("multiple site signals expire independently and never include unregistered checks", async () => {
    const rows = [4, 5, 6, 7, 8, 9, 10, 12].map((id) => ({
        monitorID: id,
        ownerID: 1,
        host: `site-${id}.test`,
        observedAt: now,
        state: "idle",
    }));
    rows[0] = { ...rows[0], state: "active", work: { ...work, deadline: now - 1 } };
    rows[1] = { ...rows[1], state: "active", work };
    const filename = observation({ version: 1, records: rows });
    for (const id of [4, 5, 6, 7, 8, 9, 10, 12]) {
        const current = { ...monitor, id, url: `https://site-${id}.test/` };
        const value = await signalForMonitor(current, now, filename);
        const expected = { 4: "overdue", 5: "active" };
        assert.equal(value.state, expected[id] || "idle");
    }
    assert.equal(await signalForMonitor({ ...monitor, id: 11, url: "https://site-11.test/" }, now, filename), null);
});

test("a work signal for a nonstandard port cannot suppress a different endpoint on the same host", async () => {
    const endpoint = { ...monitor, url: "https://example.test:8443/health" };
    const filename = observation({ version: 1, records: [record({ host: "example.test:8443" })] });
    assert.equal((await signalForMonitor(endpoint, now, filename)).state, "active");
    assert.equal(await signalForMonitor(monitor, now, filename), null);
    const plainHost = observation({ version: 1, records: [record()] });
    assert.equal(await signalForMonitor(endpoint, now, plainHost), null);
});

test("project sanitation preserves a fixed work reason and cannot promote an HTTP error to maintenance", () => {
    const beat = { status: 3, time: new Date(now).toISOString(), msg: workMessage(work) };
    const saved = safeBeat(beat);
    assert.equal(workFromBeat(saved).kind, "update");
    const incident = incidentEvidence(monitor, [saved], now);
    assert.equal(incident.state, "maintenance");
    assert.equal(incident.recent[0].workLabel, "siteWorkKind_update");
    assert.equal(workFromBeat(safeBeat({ ...beat, status: 0 })), null);
    assert.equal(safeBeat({ ...beat, msg: "remote password=secret" }).msg.includes("secret"), false);
});

test("work notices distinguish completion, overdue, lost source and a pending retry", () => {
    for (const [event, status, phrase] of [
        ["started", 3, "Начались плановые работы"],
        ["finished", 1, "Работы завершены — сайт доступен"],
        ["finished", 0, "Сбой после завершения работ"],
        ["overdue", 0, "Срок работ истёк — подтверждён сбой"],
        ["signal_lost", 1, "Сигнал о работах потерян — сайт отвечает"],
        ["finished", 2, "ожидается повторная проверка"],
    ]) {
        const text = monitorMessage(
            monitor,
            { status, time: new Date(now).toISOString(), msg: "HTTP 503 password=secret" },
            "ru",
            "https://monitor.test",
            1,
            { event, work }
        );
        assert.ok(text.includes(phrase));
        assert.equal(text.includes("secret"), false);
        assert.equal(text.includes("undefined"), false);
        assert.ok(text.includes("https://monitor.test/projects/1?check=9"));
    }
});
