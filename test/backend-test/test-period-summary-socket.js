const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { promisify } = require("node:util");
const path = require("node:path");
const { Database } = require("../../server/utils/sqlite-driver");
const { R } = require("redbean-node");
const { periodSummarySocketHandler } = require("../../server/socket-handlers/period-summary-socket-handler");

const payload = { monitorID: 1, start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:05:00.000Z" };

/**
 * @param {TestContext} context Test lifecycle
 * @returns {Promise<object>} Isolated real database
 */
async function database(context) {
    const db = new Database(":memory:");
    const exec = promisify(db.exec).bind(db);
    const get = promisify(db.get).bind(db);
    const all = promisify(db.all).bind(db);
    context.after(() => promisify(db.close).call(db));
    await exec(`
        CREATE TABLE monitor (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, name TEXT);
        CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, monitor_id INTEGER, time TEXT, status INTEGER, ping REAL, check_interval REAL, check_session TEXT, msg TEXT, response TEXT);
        CREATE INDEX monitor_time_index ON heartbeat (monitor_id, time);
        INSERT INTO monitor VALUES (1, 5, 'http', 'Owned'), (2, 6, 'http', 'Other owner'), (3, 5, 'group', 'Group');
        INSERT INTO heartbeat VALUES
            (1, 1, '2025-12-31 23:59:30.000', 1, 900, 60, 'run-a', 'secret', 'body'),
            (2, 1, '2026-01-01 00:00:00', 1, 0, 60, 'run-a', 'secret', 'body'),
            (3, 1, '2026-01-01 00:01:00.000', 0, 999, 60, 'run-a', 'secret', 'body'),
            (4, 1, '2026-01-01 00:03:00.000', 2, NULL, 10, 'run-a', 'secret', 'body'),
            (5, 1, '2026-01-01 00:03:10.000', 3, NULL, 60, 'run-a', 'secret', 'body'),
            (6, 1, '2026-01-01 00:04:10.000', 1, 30, 60, 'run-a', 'secret', 'body'),
            (7, 1, '2026-01-01 00:05:00.000', 1, 999, 60, 'run-a', 'secret', 'body'),
            (8, 2, '2026-01-01 00:00:00.000', 0, 987654, 60, 'run-a', 'other secret', 'other body');
    `);
    context.mock.method(R, "findOne", (table, where, parameters) =>
        get(`SELECT * FROM ${table} WHERE ${where}`, parameters)
    );
    context.mock.method(R, "getRow", get);
    context.mock.method(R, "getAll", all);
    return { exec, get, all };
}

/**
 * @param {number|undefined} userID Signed-in owner
 * @returns {object} Socket and captured endpoint
 */
function handler(userID = 5) {
    let endpoint;
    const socket = {
        userID,
        on: (event, callback) => {
            endpoint = callback;
        },
    };
    periodSummarySocketHandler(socket);
    return {
        socket,
        request: async (data = payload) => {
            let response;
            await endpoint(data, (result) => {
                response = result;
            });
            return response;
        },
        withoutAck: (data) => endpoint(data),
    };
}

describe("Period summary authorization, limits and real SQL", () => {
    test("requires login and acknowledgements before any database work", async (context) => {
        const find = context.mock.method(R, "findOne", () => {
            throw new Error("Unexpected query");
        });
        const anonymous = handler(null);
        assert.equal((await anonymous.request()).ok, false);
        await anonymous.withoutAck(payload);
        assert.equal(find.mock.calls.length, 0);
    });

    test("clips adjacent boundary rows without including them as samples or leaking bodies", async (context) => {
        await database(context);
        const result = await handler().request();
        assert.equal(result.ok, true);
        assert.deepEqual(result.summary.time, {
            up: 110_000,
            down: 60_000,
            pending: 10_000,
            maintenance: 60_000,
            unknown: 60_000,
            total: 300_000,
        });
        assert.equal(result.summary.counts.total, 5);
        assert.deepEqual(result.summary.response, { samples: 2, mean: 15, min: 0, max: 30, p95: 30 });
        assert.ok(!JSON.stringify(result).includes("secret") && !JSON.stringify(result).includes("body"));
        assert.ok(R.getAll.mock.calls.every((call) => !/\b(?:msg|response)\b/.test(call.arguments[0])));
    });

    test("rejects foreign, missing and group monitors plus malformed, excessive and future periods", async (context) => {
        await database(context);
        const endpoint = handler();
        for (const monitorID of [2, 3, 999]) {
            assert.equal((await endpoint.request({ ...payload, monitorID })).msg, "exportHistoryMonitorNotFound");
        }
        for (const data of [
            null,
            { ...payload, monitorID: "1 OR 1=1" },
            { ...payload, end: payload.start },
            { ...payload, end: "2026-03-01T00:00:00.000Z" },
            {
                ...payload,
                start: new Date(Date.now() - 60000).toISOString(),
                end: new Date(Date.now() + 30000).toISOString(),
            },
        ]) {
            assert.equal((await endpoint.request(data)).msg, "exportHistoryInvalidRange");
        }
        assert.equal((await endpoint.request()).ok, true);
    });

    test("does not convert empty or legacy-only history into successful time", async (context) => {
        const db = await database(context);
        await db.exec("UPDATE heartbeat SET check_interval = NULL, check_session = NULL");
        const endpoint = handler();
        const legacy = await endpoint.request();
        assert.equal(legacy.summary.availability, null);
        assert.equal(legacy.summary.time.unknown, 300_000);
        assert.equal(legacy.summary.legacyChecks, 5);
        const empty = await endpoint.request({
            ...payload,
            start: "2026-02-01T00:00:00.000Z",
            end: "2026-02-01T00:05:00.000Z",
        });
        assert.equal(empty.summary.counts.total, 0);
        assert.equal(empty.summary.coverage, 0);
    });

    test("caps rows at the database and refuses a partial summary", async (context) => {
        const db = await database(context);
        await db.exec(`WITH RECURSIVE checks(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM checks WHERE n < 50001)
            INSERT INTO heartbeat (monitor_id, time, status, check_interval, check_session)
            SELECT 1, '2026-01-01 00:00:10.000', 1, 1, 'run-a' FROM checks`);
        const result = await handler().request();
        assert.deepEqual(result, { ok: false, msg: "periodSummaryTooLarge", msgi18n: true });
        assert.equal(R.getRow.mock.calls.length, 0);
    });

    test("serializes all connections for an account and releases the lock on database failure", async (context) => {
        await database(context);
        const original = R.getAll;
        let unblock;
        let entered;
        const ready = new Promise((resolve) => {
            entered = resolve;
        });
        context.mock.method(R, "getAll", async (...args) => {
            entered();
            await new Promise((resolve) => {
                unblock = resolve;
            });
            return original(...args);
        });
        const first = handler().request();
        await ready;
        assert.equal((await handler().request()).msg, "periodSummaryBusy");
        unblock();
        assert.equal((await first).ok, true);
        context.mock.method(R, "getAll", async () => {
            throw new Error("Owned database failure fixture");
        });
        assert.equal((await handler().request()).msg, "periodSummaryFailed");
        context.mock.method(R, "getAll", original);
        assert.equal((await handler().request()).ok, true);
    });

    test("discards the result when a socket changes account while queries are running", async (context) => {
        await database(context);
        const connection = handler();
        const original = R.getAll;
        context.mock.method(R, "getAll", async (...args) => {
            const rows = await original(...args);
            connection.socket.userID = 6;
            return rows;
        });
        const result = await connection.request();
        assert.equal(result.ok, false);
        assert.equal(result.summary, undefined);
    });
});

test("the observation migration preserves old SQLite rows and can be rolled back", async (context) => {
    const Dialect = require("knex/lib/dialects/sqlite3");
    Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
    const db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
    context.after(() => db.destroy());
    await db.schema.createTable("heartbeat", (table) => {
        table.increments("id");
        table.text("time");
        table.integer("status");
    });
    await db("heartbeat").insert({ time: "2026-01-01 00:00:00", status: 1 });
    const migration = require(path.join("../../db/knex_migrations/2026-11-01-0100-heartbeat-observation-window"));
    await migration.up(db);
    const row = await db("heartbeat").first();
    assert.equal(row.check_interval, null);
    assert.equal(row.check_session, null);
    await db("heartbeat").insert({
        time: "2026-01-01 00:01:00",
        status: 0,
        check_interval: 10.5,
        check_session: "run-test",
    });
    assert.equal((await db("heartbeat").where({ status: 0 }).first()).check_interval, 10.5);
    await migration.down(db);
    assert.equal((await db("heartbeat")).length, 2);
    assert.equal(await db.schema.hasColumn("heartbeat", "check_session"), false);
});
