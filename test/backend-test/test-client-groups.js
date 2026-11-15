const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { R } = require("redbean-node");
const {
    listClientGroups,
    saveClientGroup,
    deleteClientGroup,
    buildClientReport,
} = require("../../server/client-groups");
const { clientGroupSocketHandler } = require("../../server/socket-handlers/client-group-socket-handler");
const migration = require("../../db/knex_migrations/2026-11-01-0200-client-groups");

/**
 * @param {TestContext} context Test lifecycle
 * @returns {Promise<object>} Real isolated database and endpoint
 */
async function fixture(context) {
    const Dialect = require("knex/lib/dialects/sqlite3");
    Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
    const db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
    context.after(() => db.destroy());
    R.setup(db);
    await db.raw("PRAGMA foreign_keys=ON");
    await db.schema.createTable("user", (table) => {
        table.increments("id");
    });
    await db.schema.createTable("monitor", (table) => {
        table.increments("id");
        table.integer("user_id");
        table.text("name");
        table.text("type");
    });
    await db.schema.createTable("heartbeat", (table) => {
        table.increments("id");
        table.integer("monitor_id");
        table.text("time");
        table.integer("status");
        table.float("ping");
        table.double("check_interval");
        table.string("check_session");
        table.text("msg");
        table.text("response");
        table.index(["monitor_id", "time"]);
    });
    await db("user").insert([{ id: 5 }, { id: 6 }]);
    await db("monitor").insert([
        { id: 1, user_id: 5, name: "Site A", type: "http" },
        { id: 2, user_id: 5, name: "Site B", type: "push" },
        { id: 3, user_id: 6, name: "Private other monitor", type: "http" },
        { id: 4, user_id: 5, name: "Upstream group", type: "group" },
    ]);
    await db("heartbeat").insert([
        {
            monitor_id: 1,
            time: "2026-01-01 00:00:00",
            status: 1,
            ping: 0,
            check_interval: 60,
            check_session: "run-a",
            msg: "private-message",
            response: "private-response",
        },
        {
            monitor_id: 1,
            time: "2026-01-01 00:01:00.000",
            status: 1,
            ping: 15,
            check_interval: 60,
            check_session: "run-a",
        },
        { monitor_id: 2, time: "2026-01-01 00:00:00.000", status: 0, check_interval: 300, check_session: "run-b" },
        { monitor_id: 2, time: "2026-01-01 00:05:00.000", status: 0, check_interval: 300, check_session: "run-b" },
        {
            monitor_id: 3,
            time: "2026-01-01 00:00:00.000",
            status: 1,
            ping: 987654321,
            check_interval: 300,
            check_session: "run-b",
        },
    ]);
    await migration.up(db);
    return db;
}

/**
 * @param {number|null} userID Socket account
 * @returns {object} Captured private socket endpoints
 */
function connection(userID = 5) {
    const handlers = {};
    const socket = {
        userID,
        on: (event, callback) => {
            handlers[event] = callback;
        },
    };
    clientGroupSocketHandler(socket);
    return {
        socket,
        handlers,
        send: async (event, payload = {}) => {
            let response;
            await handlers[event](payload, (value) => {
                response = value;
            });
            return response;
        },
    };
}

const fields = { name: "Клиент <script>test</script>", monitorIDs: [1, 2] };
const dates = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:05:00.000Z" };

describe("Client grouping and reports", () => {
    test("persists owner-scoped membership, allows shared checks and rejects stale editors", async (context) => {
        await fixture(context);
        const first = await saveClientGroup(5, fields);
        await saveClientGroup(5, { name: "Second", monitorIDs: [1] });
        await saveClientGroup(6, { name: "Foreign", monitorIDs: [3] });
        const clients = await listClientGroups(5);
        assert.equal(clients.length, 2);
        assert.deepEqual(clients[0], { ...first, name: fields.name, monitorIDs: [1, 2] });
        assert.equal((await listClientGroups(6)).length, 1);
        const changed = await saveClientGroup(5, { ...first, name: "Updated", monitorIDs: [2] });
        assert.equal(changed.revision, 2);
        await assert.rejects(saveClientGroup(5, { ...first, ...fields }), /clientGroupChanged/);
        assert.deepEqual((await listClientGroups(5))[0].monitorIDs, [2]);
    });

    test("validates names and distinct IDs and atomically refuses foreign or group monitors", async (context) => {
        const db = await fixture(context);
        for (const request of [
            null,
            { ...fields, name: "  " },
            { ...fields, name: "x".repeat(121) },
            { ...fields, name: "test\nname" },
            { ...fields, monitorIDs: [1, 1] },
            { ...fields, monitorIDs: [3] },
            { ...fields, monitorIDs: [4] },
            { ...fields, monitorIDs: [999] },
            { ...fields, monitorIDs: ["1 OR 1=1"] },
            { ...fields, monitorIDs: Array.from({ length: 101 }, (_, i) => i + 1) },
        ]) {
            await assert.rejects(saveClientGroup(5, request), /clientGroupInvalid/);
        }
        assert.equal((await db("client_group")).length, 0);
        const client = await saveClientGroup(5, fields);
        await assert.rejects(saveClientGroup(5, { ...client, ...fields, monitorIDs: [1, 3] }), /clientGroupInvalid/);
        assert.equal((await listClientGroups(5))[0].revision, 1);
        assert.deepEqual((await listClientGroups(5))[0].monitorIDs, [1, 2]);
    });

    test("weights total time, keeps gaps and separate response percentiles, and excludes private data", async (context) => {
        await fixture(context);
        const client = await saveClientGroup(5, fields);
        const report = await buildClientReport(5, { ...client, ...dates });
        assert.equal(report.monitors.length, 2);
        assert.equal(report.monitors[0].summary.availability, 1);
        assert.equal(report.monitors[1].summary.availability, 0);
        assert.equal(report.totals.time.up, 60_000);
        assert.equal(report.totals.time.down, 300_000);
        assert.equal(report.totals.time.unknown, 240_000);
        assert.equal(report.totals.time.total, 600_000);
        assert.equal(report.totals.availability, 1 / 6);
        assert.equal(report.totals.coverage, 0.6);
        assert.equal(report.totals.counts.total, 3);
        assert.equal(report.monitors[0].summary.response.p95, 15);
        assert.equal(report.monitors[1].summary.response.p95, null);
        assert.equal(report.totals.response, undefined);
        for (const text of [
            "private-message",
            "private-response",
            "Private other monitor",
            "987654321",
            "check_session",
        ]) {
            assert.ok(!JSON.stringify(report).includes(text));
        }
    });

    test("rejects foreign clients, malformed and future ranges, and stale report revisions", async (context) => {
        await fixture(context);
        const client = await saveClientGroup(5, fields);
        await assert.rejects(buildClientReport(6, { ...client, ...dates }), /clientGroupNotFound/);
        for (const request of [
            { ...client, ...dates, revision: 2 },
            { ...client, ...dates, start: dates.end },
            { ...client, ...dates, end: "2026-03-01T00:00:00.000Z" },
            {
                ...client,
                ...dates,
                start: new Date(Date.now() - 60000).toISOString(),
                end: new Date(Date.now() + 30000).toISOString(),
            },
        ]) {
            await assert.rejects(buildClientReport(5, request), /clientGroupChanged|exportHistoryInvalidRange/);
        }
    });

    test("keeps empty and legacy-only groups unknown, including the monitor-time denominator", async (context) => {
        const db = await fixture(context);
        const empty = await saveClientGroup(5, { name: "Empty", monitorIDs: [] });
        const result = await buildClientReport(5, { ...empty, ...dates });
        assert.equal(result.totals.availability, null);
        assert.equal(result.totals.coverage, null);
        assert.equal(result.totals.time.total, 0);
        await db("heartbeat").update({ check_interval: null, check_session: null });
        const client = await saveClientGroup(5, fields);
        const report = await buildClientReport(5, { ...client, ...dates });
        assert.equal(report.totals.time.unknown, 600_000);
        assert.equal(report.totals.legacyChecks, 3);
        assert.equal(report.totals.availability, null);
    });

    test("deletes only the grouping, preserves observations and rolls back writes if account guard fails", async (context) => {
        const db = await fixture(context);
        const client = await saveClientGroup(5, fields);
        const guard = () => {
            throw new Error("Account changed");
        };
        await assert.rejects(
            saveClientGroup(5, { ...client, name: "Unsafe update", monitorIDs: [2] }, guard),
            /Account changed/
        );
        await assert.rejects(deleteClientGroup(5, client, guard), /Account changed/);
        assert.deepEqual((await listClientGroups(5))[0].monitorIDs, [1, 2]);
        assert.equal((await listClientGroups(5))[0].revision, 1);
        await assert.rejects(deleteClientGroup(6, client), /clientGroupChanged/);
        await deleteClientGroup(5, client);
        assert.equal((await db("client_group_monitor")).length, 0);
        assert.equal((await db("monitor")).length, 4);
        assert.equal((await db("heartbeat")).length, 5);
    });

    test("fails closed if foreign membership is inserted outside the application", async (context) => {
        const db = await fixture(context);
        const client = await saveClientGroup(5, { name: "Owned", monitorIDs: [1] });
        await db("client_group_monitor").insert({ client_group_id: client.id, monitor_id: 3 });
        await assert.rejects(buildClientReport(5, { ...client, ...dates }), /clientGroupInvalid/);
        assert.deepEqual((await listClientGroups(5))[0].monitorIDs, [1]);
    });

    test("uses one shared history budget across clients' checks instead of 50,000 per check", async (context) => {
        const db = await fixture(context);
        const client = await saveClientGroup(5, fields);
        await db.raw(`WITH RECURSIVE samples(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM samples WHERE n < 25001)
            INSERT INTO heartbeat (monitor_id, time, status, check_interval, check_session)
            SELECT 1, '2026-01-01 00:02:00.000', 1, 60, 'run-a' FROM samples`);
        await db.raw(`WITH RECURSIVE samples(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM samples WHERE n < 25000)
            INSERT INTO heartbeat (monitor_id, time, status, check_interval, check_session)
            SELECT 2, '2026-01-01 00:02:00.000', 0, 60, 'run-b' FROM samples`);
        await assert.rejects(buildClientReport(5, { ...client, ...dates }), /periodSummaryTooLarge/);
    });

    test("caps groups and rejects a changed membership during report construction", async (context) => {
        const db = await fixture(context);
        const client = await saveClientGroup(5, fields);
        await db("client_group").insert(
            Array.from({ length: 99 }, (_, i) => ({ user_id: 5, name: "Extra " + i, revision: 1 }))
        );
        await assert.rejects(saveClientGroup(5, { name: "Overflow", monitorIDs: [] }), /clientGroupLimit/);
        const original = R.getAll.bind(R);
        let once = true;
        context.mock.method(R, "getAll", async (...args) => {
            const rows = await original(...args);
            if (once) {
                once = false;
                await db("client_group_monitor").where({ client_group_id: client.id, monitor_id: 2 }).delete();
            }
            return rows;
        });
        await assert.rejects(buildClientReport(5, { ...client, ...dates }), /clientGroupChanged/);
    });

    test("socket endpoints require sign-in and ack, serialize account operations and reject account changes", async (context) => {
        await fixture(context);
        const anonymous = connection(null);
        for (const event of Object.keys(anonymous.handlers)) {
            assert.equal((await anonymous.send(event, fields)).ok, false);
            await anonymous.handlers[event](fields);
        }
        const owner = connection();
        const saved = await owner.send("saveClientGroup", fields);
        assert.equal(saved.ok, true);
        const original = R.getAll.bind(R);
        let entered;
        let unblock;
        const ready = new Promise((resolve) => {
            entered = resolve;
        });
        let once = true;
        context.mock.method(R, "getAll", async (...args) => {
            if (once) {
                once = false;
                entered();
                await new Promise((resolve) => {
                    unblock = resolve;
                });
            }
            return original(...args);
        });
        const first = owner.send("getClientReport", { ...saved.client, ...dates });
        await ready;
        assert.equal((await connection().send("saveClientGroup", fields)).msg, "clientGroupBusy");
        assert.equal((await connection(6).send("listClientGroups")).ok, true);
        owner.socket.userID = 6;
        unblock();
        assert.equal((await first).ok, false);
        assert.equal((await connection().send("listClientGroups")).ok, true);
    });

    test("migration rollback leaves monitor history intact and removes only new grouping tables", async (context) => {
        const db = await fixture(context);
        await saveClientGroup(5, fields);
        await migration.down(db);
        assert.equal(await db.schema.hasTable("client_group"), false);
        assert.equal((await db("monitor")).length, 4);
        assert.equal((await db("heartbeat")).length, 5);
        await migration.up(db);
        assert.deepEqual(await listClientGroups(5), []);
    });
});
