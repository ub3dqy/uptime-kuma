const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const net = require("node:net");
const sqlite = require("../../server/utils/sqlite-driver");
const { MqttMonitorType } = require("../../server/monitor-types/mqtt");

describe("Installation dependency compatibility", () => {
    test("the maintained SQLite binding loads", () => {
        const database = require("better-sqlite3")(":memory:");
        try {
            assert.match(database.prepare("select sqlite_version() as version").get().version, /^3\.5[3-9]\./);
        } finally {
            database.close();
        }
    });

    test("the SQLite binding preserves parameters, binary data and transaction rollback", async (context) => {
        let database;
        await new Promise((resolve, reject) => {
            database = new sqlite.Database(":memory:", (error) => (error ? reject(error) : resolve()));
        });
        context.after(
            () => new Promise((resolve, reject) => database.close((error) => (error ? reject(error) : resolve())))
        );
        const execute = promisify(database.exec).bind(database);
        const query = promisify(database.get).bind(database);
        await execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, payload BLOB, note TEXT)");
        const payload = Buffer.from([0, 255, 13, 10, 42]);
        const note = "Клиент №1 — проверка";
        await promisify(database.run).call(database, "INSERT INTO sample VALUES (?, ?, ?)", [1, payload, note]);
        await execute("BEGIN IMMEDIATE; INSERT INTO sample VALUES (2, NULL, 'rollback'); ROLLBACK");
        const row = await query("SELECT payload, note FROM sample WHERE id = ?", [1]);
        assert.deepEqual(row.payload, payload);
        assert.equal(row.note, note);
        assert.equal((await query("SELECT COUNT(*) AS count FROM sample")).count, 1);
    });

    test("the MQTT monitor receives messages from a loopback broker", { timeout: 15000 }, async (context) => {
        const { Aedes } = await import("aedes");
        const broker = await Aedes.createBroker();
        const sockets = new Set();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            broker.handle(socket);
        });
        context.after(async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise((resolve) => server.close(resolve));
            await new Promise((resolve, reject) => broker.close((error) => (error ? reject(error) : resolve())));
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        await new Promise((resolve, reject) =>
            broker.publish(
                {
                    topic: "kuma/installation-check",
                    payload: Buffer.from("ready"),
                    qos: 0,
                    retain: true,
                },
                (error) => (error ? reject(error) : resolve())
            )
        );
        const heartbeat = {};
        await new MqttMonitorType().check(
            {
                hostname: "127.0.0.1",
                port: server.address().port,
                mqttTopic: "kuma/installation-check",
                mqttCheckType: "keyword",
                mqttSuccessMessage: "ready",
                interval: 10,
                conditions: "[]",
            },
            heartbeat,
            {}
        );
        assert.equal(heartbeat.status, 1);
        assert.match(heartbeat.msg, /ready/);
    });

    const helpCases = [
        [["help"], /MQTT\.js command line interface/],
        [["help", "publish"], /Usage: mqtt publish/],
        [["help", "subscribe"], /Usage: mqtt subscribe/],
        [["publish", "--help"], /Usage: mqtt publish/],
        [["subscribe", "--help"], /Usage: mqtt subscribe/],
    ];
    for (const [args, expected] of helpCases) {
        test("MQTT CLI " + args.join(" ") + " works without a broker", async () => {
            const mqttDirectory = path.dirname(require.resolve("mqtt/package.json"));
            const { stdout } = await promisify(execFile)(
                process.execPath,
                [path.join(mqttDirectory, require("mqtt/package.json").bin.mqtt), ...args],
                { timeout: 10000, maxBuffer: 256 * 1024 }
            );
            assert.match(stdout, expected);
        });
    }
});
