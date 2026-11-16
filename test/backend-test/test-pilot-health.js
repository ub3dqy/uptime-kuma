const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { probe } = require("../../extra/pilot-healthcheck.cjs");
const { dailyReport } = require("../../extra/pilot-daily-report.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const SQLite = require("better-sqlite3");

test("pilot health refuses HTTP errors and oversized bodies", async (context) => {
    let status = 200;
    let bytes = 1;
    const server = http.createServer((request, response) => {
        assert.equal(request.url, "/api/entry-page");
        response.writeHead(status);
        response.end("x".repeat(bytes));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    await probe(port);
    for (status of [302, 401, 404, 500, 503]) {
        await assert.rejects(probe(port));
    }
    status = 200;
    bytes = 65537;
    await assert.rejects(probe(port));
});

test("daily pilot evidence preserves gaps and refuses changed monitor scope without exposing payloads", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kuma-pilot-evidence-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const db = new SQLite(path.join(directory, "kuma.db"));
    try {
        db.exec(`CREATE TABLE monitor(id INTEGER, user_id INTEGER, name TEXT);
            CREATE TABLE heartbeat(id INTEGER PRIMARY KEY, monitor_id INTEGER, time TEXT, status INTEGER, ping REAL, check_interval REAL, check_session TEXT, msg TEXT);
            INSERT INTO monitor VALUES(1, 5, 'Pilot/UP'),(2, 6, 'Pilot/Foreign');
            INSERT INTO heartbeat VALUES(1,1,'2026-01-01 00:00:00',1,0,60,'private-run','private-message'),(2,1,'2026-01-01 00:05:00',0,NULL,60,'private-run','private-message');`);
    } finally {
        db.close();
    }
    const manifest = path.join(directory, "pilot-monitors.json");
    await fs.writeFile(manifest, JSON.stringify({ userID: 5, monitorIDs: [1] }));
    const result = dailyReport(directory, "2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z");
    assert.equal(result.monitors[0].summary.time.up, 60000);
    assert.equal(result.monitors[0].summary.time.unknown, 240000);
    assert.equal(result.monitors[0].summary.response.min, 0);
    assert.ok(!JSON.stringify(result).includes("private-"));
    await fs.writeFile(manifest, JSON.stringify({ userID: 5, monitorIDs: [2] }));
    assert.throws(() => dailyReport(directory, result.start, result.end), /changed/);
    await fs.writeFile(manifest, JSON.stringify({ userID: 5, monitorIDs: [1, 1] }));
    assert.throws(() => dailyReport(directory, result.start, result.end), /scope/);
});
