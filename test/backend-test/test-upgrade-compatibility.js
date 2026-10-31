const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { promisify } = require("node:util");
const { Database } = require("../../server/utils/sqlite-driver");
const { Cron, expandLegacyPlaceholders } = require("../../server/utils/maintenance-cron");
const { getOidcTokenClientCredentials: getToken } = require("../../server/oauth-client");
const { pipeline } = require("node:stream/promises");
const { createWriteStream } = require("node:fs");
const { createRequire } = require("node:module");
const net = require("node:net");

/** @param {string} filename Test database. @returns {Promise<object>} Connection. */
async function open(filename) {
    let database;
    await new Promise((resolve, reject) => {
        database = new Database(filename, (error) => (error ? reject(error) : resolve()));
    });
    return database;
}

test("a SQLite lock wait leaves timers responsive and preserves rollback and errors", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kuma-lock-"));
    const first = await open(path.join(directory, "test.db"));
    const second = await open(path.join(directory, "test.db"));
    context.after(async () => {
        await Promise.all([first, second].map((db) => promisify(db.close).call(db)));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const run = (db, sql, params = []) => promisify(db.run).call(db, sql, params);
    await run(first, "CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)");
    await run(first, "BEGIN IMMEDIATE");
    await run(first, "INSERT INTO sample VALUES (1, 'rollback')");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    context.after(() => clearInterval(timer));
    const pending = run(second, "INSERT INTO sample VALUES (2, 'committed')");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await run(first, "ROLLBACK");
    await pending;
    assert.ok(ticks >= 5, "waiting for SQLite must not block the monitoring loop");
    assert.deepEqual(await promisify(second.all).call(second, "SELECT * FROM sample"), [{ id: 2, value: "committed" }]);
    await assert.rejects(run(second, "INSERT INTO sample VALUES (2, 'duplicate')"), {
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
    });
});

test("maintenance preserves legacy steps, last-day schedules and timezone placeholders", () => {
    const date = new Date("2026-10-31T22:04:05Z");
    assert.equal(expandLegacyPlaceholders("? ? ? ? ? ?", "Europe/Moscow", date), "5 4 1 1 11 0");
    assert.equal(expandLegacyPlaceholders("? ? * * *", "UTC", date), "4 22 * * *");
    for (const pattern of ["0/10 * * * *", "0 0 L * *"]) {
        const job = new Cron(pattern, { timezone: "UTC", paused: true });
        try {
            assert.ok(job.nextRun(date) instanceof Date);
        } finally {
            job.stop();
        }
    }
    const job = new Cron("0 0 * * *", { timezone: "UTC", paused: true, startAt: "2026-11-03T00:00:00Z" });
    try {
        assert.ok(job.nextRun(date) >= new Date("2026-11-03T00:00:00Z"));
    } finally {
        job.stop();
    }
});

test("the legacy TLS-table upgrade preserves rows, sequence and cascading ownership", async (context) => {
    const db = await open(":memory:");
    context.after(() => promisify(db.close).call(db));
    const exec = promisify(db.exec).bind(db);
    const get = promisify(db.get).bind(db);
    await exec(
        "PRAGMA foreign_keys=ON; CREATE TABLE monitor (id INTEGER PRIMARY KEY); INSERT INTO monitor VALUES (1);" +
            "CREATE TABLE monitor_tls_info (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL, info_json TEXT);" +
            "INSERT INTO monitor_tls_info VALUES (2, 1, 'certificate'); INSERT INTO monitor_tls_info VALUES (9, 1, 'deleted'); DELETE FROM monitor_tls_info WHERE id=9"
    );
    await exec(
        await fs.readFile(path.join(__dirname, "../../db/old_migrations/patch-monitor-tls-info-add-fk.sql"), "utf8")
    );
    assert.equal((await get("SELECT info_json FROM monitor_tls_info WHERE id=2")).info_json, "certificate");
    await exec("INSERT INTO monitor_tls_info (monitor_id, info_json) VALUES (1, 'next')");
    assert.equal((await get("SELECT MAX(id) AS id FROM monitor_tls_info")).id, 10);
    await exec("DELETE FROM monitor WHERE id=1");
    assert.equal((await get("SELECT COUNT(*) AS count FROM monitor_tls_info")).count, 0);
    await assert.rejects(exec("INSERT INTO monitor_tls_info (monitor_id) VALUES (99)"), {
        code: "SQLITE_CONSTRAINT_FOREIGNKEY",
    });
    await exec(
        await fs.readFile(path.join(__dirname, "../../db/old_migrations/patch-monitor-tls-info-add-fk.sql"), "utf8")
    );
    await exec("INSERT INTO monitor VALUES (2); INSERT INTO monitor_tls_info (monitor_id) VALUES (2)");
    assert.equal((await get("SELECT id FROM monitor_tls_info")).id, 11);
});

test("legacy file imports retain orphan TLS records and restore pool state after a failure", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kuma-legacy-"));
    const Dialect = require("knex/lib/dialects/sqlite3");
    Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
    const db = require("knex")({
        client: Dialect,
        connection: { filename: path.join(directory, "test.db") },
        useNullAsDefault: true,
        pool: {
            min: 0,
            max: 3,
            afterCreate(connection, done) {
                connection.run("PRAGMA foreign_keys=ON", (error) => done(error, connection));
            },
        },
    });
    context.after(async () => {
        await db.destroy();
        await fs.rm(directory, { recursive: true, force: true });
    });
    const { R } = require("redbean-node");
    R.setup(db);
    const Database = require("../../server/database");
    await db.raw("CREATE TABLE monitor (id INTEGER PRIMARY KEY)");
    await db.raw(
        "CREATE TABLE monitor_tls_info (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL, info_json TEXT)"
    );
    await db("monitor").insert({ id: 1 });
    await db("monitor_tls_info").insert([
        { id: 2, monitor_id: 1, info_json: "valid" },
        { id: 3, monitor_id: 99, info_json: "old orphan" },
    ]);
    await Database.importSQLFile(path.join(__dirname, "../../db/old_migrations/patch-monitor-tls-info-add-fk.sql"));
    assert.equal((await db.raw("PRAGMA foreign_keys"))[0].foreign_keys, 1);
    // Database.patch disables checks during the following Knex migration batch;
    // historical orphan records must survive that batch as well.
    await db.raw("PRAGMA foreign_keys=OFF");
    await db.schema.alterTable("monitor_tls_info", (table) => table.text("info_json", "longtext").alter());
    await db.raw("PRAGMA foreign_keys=ON");
    assert.equal((await db("monitor_tls_info").where({ id: 3 }).first()).info_json, "old orphan");
    await assert.rejects(db("monitor_tls_info").insert({ monitor_id: 100 }), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    const broken = path.join(directory, "broken.sql");
    await fs.writeFile(
        broken,
        "PRAGMA foreign_keys=OFF; BEGIN TRANSACTION; CREATE TABLE must_rollback (id INTEGER); invalid fixture SQL;"
    );
    await assert.rejects(Database.importSQLFile(broken));
    assert.equal(await db.schema.hasTable("must_rollback"), false);
    assert.equal((await db.raw("PRAGMA foreign_keys"))[0].foreign_keys, 1);
});

test("OAuth preserves both authentication methods, expiry and redirect refusal without leaking secrets", async (context) => {
    let requestData;
    let redirectHits = 0;
    const server = http.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) {
            body += chunk;
        }
        requestData = { body: new URLSearchParams(body), headers: request.headers };
        if (request.url === "/redirect") {
            response.writeHead(302, { Location: "/destination" }).end();
        } else if (request.url === "/destination") {
            redirectHits++;
            response.end("{}");
        } else {
            response.setHeader("Content-Type", "application/json");
            response.end(
                JSON.stringify(
                    request.url === "/bad"
                        ? { access_token: "secret", token_type: "Bearer", expires_in: -1 }
                        : { access_token: "token", token_type: "Bearer", expires_in: 60 }
                )
            );
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const endpoint = "http://127.0.0.1:" + server.address().port;
    const id = "клиент: +&";
    const secret = "never-log-this:+&";
    for (const method of ["client_secret_basic", "client_secret_post"]) {
        const start = Math.floor(Date.now() / 1000);
        const token = await getToken(endpoint, id, secret, "read write", "test", method);
        assert.equal(token.access_token, "token");
        assert.ok(token.expires_at >= start + 60);
        assert.equal(requestData.body.get("grant_type"), "client_credentials");
        assert.equal(requestData.body.get("scope"), "read write");
        assert.equal(requestData.body.get("audience"), "test");
        if (method === "client_secret_post") {
            assert.equal(requestData.body.get("client_secret"), secret);
            assert.equal(requestData.headers.authorization, undefined);
        } else {
            const encoded = Buffer.from(requestData.headers.authorization.slice(6), "base64").toString();
            assert.equal(encoded, "%D0%BA%D0%BB%D0%B8%D0%B5%D0%BD%D1%82%3A+%2B%26:never-log-this%3A%2B%26");
            assert.equal(requestData.body.has("client_secret"), false);
        }
    }
    await assert.rejects(getToken(endpoint + "/bad", id, secret), /Invalid OAuth token expiry/);
    await assert.rejects(getToken(endpoint + "/redirect", id, secret), (error) => {
        assert.equal(error.message, "OAuth token request failed (HTTP 302)");
        assert.equal(error.config, undefined);
        assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes(secret));
        return true;
    });
    assert.equal(redirectHits, 0);
    await assert.rejects(getToken("file:///tmp/token", id, secret), /Invalid OAuth token endpoint/);
    await assert.rejects(getToken(endpoint, id, secret, "", "", "none"), /Unsupported OAuth/);
});

test("test-container archive traversal preserves glob filters with current Minimatch", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kuma-archive-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.mkdir(destination);
    await fs.writeFile(path.join(source, "keep.txt"), "Перенос ✓");
    await fs.writeFile(path.join(source, "nested", "keep.txt"), "nested");
    await fs.writeFile(path.join(source, "exclude.bin"), "excluded");
    const archive = require("archiver")("tar");
    const archivePath = path.join(directory, "test.tar");
    const written = pipeline(archive, createWriteStream(archivePath));
    archive.glob("**/*.txt", { cwd: source });
    await archive.finalize();
    await written;
    await require("tar").x({ file: archivePath, cwd: destination });
    assert.equal(await fs.readFile(path.join(destination, "keep.txt"), "utf8"), "Перенос ✓");
    assert.equal(await fs.readFile(path.join(destination, "nested", "keep.txt"), "utf8"), "nested");
    await assert.rejects(fs.stat(path.join(destination, "exclude.bin")), { code: "ENOENT" });
});

test("Prometheus middleware and monitor gauges use a single current registry", async (context) => {
    const client = require("prom-client");
    const middlewareRequire = createRequire(require.resolve("prometheus-api-metrics"));
    assert.equal(client, middlewareRequire("prom-client"));
    const { R } = require("redbean-node");
    const { Prometheus } = require("../../server/prometheus");
    context.mock.method(R, "findAll", async () => []);
    client.register.clear();
    context.after(() => client.register.clear());
    await Prometheus.init();
    client.collectDefaultMetrics();
    const monitor = new Prometheus({ id: 1, name: "Local", type: "http", url: "http://127.0.0.1" }, []);
    monitor.update(
        { status: 1, ping: 25 },
        { valid: true, certInfo: { daysRemaining: 10 } },
        {
            data24h: { uptime: 1, avgPing: 25 },
            data30d: { uptime: 1, avgPing: 25 },
            data1y: { uptime: 1, avgPing: 25 },
        }
    );
    const text = await client.register.metrics();
    for (const metric of [
        "monitor_status",
        "monitor_cert_days_remaining",
        "monitor_uptime_ratio",
        "process_cpu_user_seconds_total",
    ]) {
        assert.match(text, new RegExp(metric));
    }
    assert.match(text, /monitor_status[^\n]* 1/);
});

test(
    "the current SFTP client completes SSH authentication and checks a remote path",
    { timeout: 15000 },
    async (context) => {
        const { Server, utils } = require("ssh2");
        const { SFTPMonitorType } = require("../../server/monitor-types/sftp");
        const clients = new Set();
        const server = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (client) => {
            clients.add(client);
            client.on("error", () => {});
            client.on("close", () => clients.delete(client));
            client.on("authentication", (request) => {
                if (request.method === "password" && request.username === "test" && request.password === "fixture") {
                    request.accept();
                } else {
                    request.reject(["password"]);
                }
            });
            client.on("ready", () =>
                client.on("session", (accept) => {
                    accept().on("sftp", (acceptSftp) => {
                        const sftp = acceptSftp();
                        const stat = (id, filename) => {
                            if (filename === "/fixture") {
                                sftp.attrs(id, { mode: 0o100644, size: 5, uid: 1, gid: 1, atime: 1, mtime: 1 });
                            } else {
                                sftp.status(id, 2);
                            }
                        };
                        sftp.on("LSTAT", stat);
                        sftp.on("STAT", stat);
                    });
                })
            );
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        context.after(async () => {
            for (const client of clients) {
                client.end();
            }
            await new Promise((resolve) => server.close(resolve));
        });
        const monitor = {
            hostname: "127.0.0.1",
            port: server.address().port,
            sshUsername: "test",
            sshPassword: "fixture",
            sftpPath: "/fixture",
            timeout: 2,
        };
        const heartbeat = {};
        const type = new SFTPMonitorType();
        await type.check(monitor, heartbeat, {});
        assert.equal(heartbeat.status, 1);
        await assert.rejects(type.check({ ...monitor, sftpPath: "/missing" }, {}, {}), /does not exist/);
    }
);

test("Redis authentication errors reject cleanly without reconnecting or escaping the monitor", async (context) => {
    const { RedisMonitorType } = require("../../server/monitor-types/redis");
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        socket.on("data", () => socket.write("-WRONGPASS invalid fixture credentials\r\n"));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise((resolve) => server.close(resolve));
    });
    await assert.rejects(
        new RedisMonitorType().redisPingAsync("redis://:fixture@127.0.0.1:" + server.address().port, true),
        /WRONGPASS/
    );
});
