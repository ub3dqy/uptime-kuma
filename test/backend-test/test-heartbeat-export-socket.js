const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const sqlite3 = require("@louislam/sqlite3");
const { R } = require("redbean-node");
const { heartbeatExportSocketHandler } = require("../../server/socket-handlers/heartbeat-export-socket-handler");

/**
 * Bind the handler's database calls to an isolated real SQLite database.
 * @param {TestContext} context Test lifecycle and mocks
 * @returns {Promise<void>}
 */
async function database(context) {
    const db = new sqlite3.Database(":memory:");
    await new Promise((resolve, reject) =>
        db.exec(
            `
        CREATE TABLE monitor (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT);
        CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, monitor_id INTEGER, time TEXT, status INTEGER, ping REAL, duration REAL, msg TEXT);
        INSERT INTO monitor VALUES (1, 5, 'Customer site'), (2, 6, 'Other owner');
        INSERT INTO heartbeat VALUES
          (1, 1, '2026-01-01 00:00:00', 1, 0, 60, 'First'),
          (2, 1, '2026-01-01 12:00:00.000', 0, NULL, 60, '=1+1'),
          (3, 1, '2026-01-02 00:00:00.000', 1, 10, 60, 'Excluded end'),
          (4, 2, '2026-01-01 00:00:00.000', 1, 10, 60, 'Other owner secret');
    `,
            (error) => (error ? reject(error) : resolve())
        )
    );
    context.after(() => new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve()))));
    const get = (sql, parameters) =>
        new Promise((resolve, reject) =>
            db.get(sql, parameters, (error, row) => (error ? reject(error) : resolve(row)))
        );
    context.mock.method(R, "findOne", (table, where, parameters) =>
        get(`SELECT * FROM ${table} WHERE ${where}`, parameters)
    );
    context.mock.method(R, "getRow", get);
    context.mock.method(
        R,
        "getAll",
        (sql, parameters) =>
            new Promise((resolve, reject) =>
                db.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve(rows)))
            )
    );
}

/**
 * Capture the registered export endpoint without a network listener.
 * @param {number|undefined} userID Authenticated owner ID
 * @returns {Function} Registered request handler
 */
function handler(userID) {
    let endpoint;
    heartbeatExportSocketHandler({
        userID,
        on: (event, callback) => {
            endpoint = callback;
        },
    });
    return endpoint;
}

/**
 * Wait until the handler has completed, including release of the account lock.
 * @param {Function} endpoint Registered request handler
 * @param {object} payload Export request
 * @returns {Promise<object>} Acknowledgement
 */
async function request(endpoint, payload) {
    let response;
    await endpoint(payload, (value) => {
        response = value;
    });
    return response;
}

const payload = { monitorID: 1, start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" };

describe("History export authorization and real SQL boundaries", () => {
    test("requires sign-in before accessing the database and tolerates missing acknowledgements", async (context) => {
        const find = context.mock.method(R, "findOne", () => {
            throw new Error("Unexpected query");
        });
        assert.equal((await request(handler(undefined), payload)).ok, false);
        assert.equal(find.mock.calls.length, 0);
        await handler(5)(payload);
        assert.equal(find.mock.calls.length, 0);
    });

    test("exports only owned retained rows within a half-open interval", async (context) => {
        await database(context);
        const result = await request(handler(5), payload);
        assert.equal(result.ok, true);
        assert.equal(result.rowCount, 2);
        assert.equal(result.filename, "monitor-1-2026-01-01-2026-01-02.csv");
        assert.ok(result.csv.includes("First"));
        assert.ok(result.csv.includes("'=1+1"));
        assert.ok(!result.csv.includes("Excluded end"));
        assert.ok(!result.csv.includes("Other owner secret"));
    });

    test("denies foreign and nonexistent monitors, rejects injection, and releases the lock after refusal", async (context) => {
        await database(context);
        const endpoint = handler(5);
        for (const monitorID of [2, 999]) {
            const result = await request(endpoint, { ...payload, monitorID });
            assert.equal(result.ok, false);
            assert.equal(result.msg, "exportHistoryMonitorNotFound");
            assert.equal(result.csv, undefined);
        }
        assert.equal((await request(endpoint, { ...payload, monitorID: "1 OR 1=1" })).ok, false);
        assert.equal((await request(endpoint, payload)).ok, true);
    });

    test("does not fabricate observations for an empty period", async (context) => {
        await database(context);
        const result = await request(handler(5), {
            ...payload,
            start: "2026-01-03T00:00:00.000Z",
            end: "2026-01-04T00:00:00.000Z",
        });
        assert.equal(result.ok, true);
        assert.equal(result.rowCount, 0);
        assert.equal(result.csv.split("\r\n").length, 2);
    });

    test("serializes concurrent requests across connections belonging to one account", async (context) => {
        await database(context);
        const original = R.getRow;
        let unblock;
        let started;
        const entered = new Promise((resolve) => {
            started = resolve;
        });
        context.mock.method(R, "getRow", async (...args) => {
            started();
            await new Promise((resolve) => {
                unblock = resolve;
            });
            return original(...args);
        });
        const first = request(handler(5), payload);
        await entered;
        const second = await request(handler(5), payload);
        assert.equal(second.ok, false);
        assert.equal(second.msg, "exportHistoryBusy");
        unblock();
        assert.equal((await first).ok, true);
    });
});
