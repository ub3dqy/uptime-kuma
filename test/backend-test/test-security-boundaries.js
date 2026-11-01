const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const express = require("express");
const axios = require("axios");
const { RateLimiter } = require("limiter");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const auth = require("../../server/auth");
const passwordHash = require("../../server/password-hash");
const { loginRateLimiter, apiRateLimiter } = require("../../server/rate-limiter");
const Monitor = require("../../server/model/monitor");
const apicache = require("../../server/modules/apicache");
const { log } = require("../../src/util");

/**
 * @param {object} server Local server.
 * @param {object} context Test context.
 * @returns {Promise<number>} Port.
 */
async function listen(server, context) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    return server.address().port;
}

/**
 * @param {number} port Port.
 * @param {string} route Path.
 * @param {object} headers Headers.
 * @returns {Promise<object>} Response.
 */
function request(port, route = "/metrics", headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: "127.0.0.1", port, path: route, headers, agent: false }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
    });
}

for (const apiKeys of [false, true]) {
    for (const parallel of [false, true]) {
        test(`${apiKeys ? "API key" : "Basic"} auth bounds ${parallel ? "parallel" : "sequential"} verification attempts`, async (context) => {
            context.mock.method(log, "warn", () => {});
            let checks = 0;
            const limit = apiKeys ? 60 : 20;
            const limiter = apiKeys ? apiRateLimiter : loginRateLimiter;
            const previous = limiter.rateLimiter;
            limiter.rateLimiter = new RateLimiter({
                tokensPerInterval: limit,
                interval: "minute",
                fireImmediately: true,
            });
            context.after(() => {
                limiter.rateLimiter = previous;
            });
            context.mock.method(Settings, "get", async (name) => name === "apiKeysEnabled" && apiKeys);
            const verify = async () => {
                checks++;
                await new Promise((resolve) => setTimeout(resolve, parallel ? 30 : 1));
                return apiKeys ? { active: 1, expires: "2099-12-31", key: "local-fixture" } : null;
            };
            context.mock.method(auth, "login", verify);
            context.mock.method(R, "findOne", verify);
            context.mock.method(passwordHash, "verify", () => false);
            const app = express();
            app.get("/metrics", auth.apiAuth, (_req, res) => res.end("local metrics"));
            const port = await listen(http.createServer(app), context);
            const headers = { Authorization: "Basic " + Buffer.from("test:uk1_wrong").toString("base64") };
            if (parallel) {
                await Promise.all(Array.from({ length: limit + 10 }, () => request(port, "/metrics", headers)));
            } else {
                for (let i = 0; i < limit + 2; i++) {
                    assert.equal((await request(port, "/metrics", headers)).status, 401);
                }
            }
            assert.equal(checks, limit);
        });
    }
}

test("valid Basic authentication works and remains subject to the same HTTP attempt limit", async (context) => {
    context.mock.method(log, "warn", () => {});
    const previous = loginRateLimiter.rateLimiter;
    loginRateLimiter.rateLimiter = new RateLimiter({
        tokensPerInterval: 20,
        interval: "minute",
        fireImmediately: true,
    });
    context.after(() => {
        loginRateLimiter.rateLimiter = previous;
    });
    context.mock.method(Settings, "get", async () => false);
    context.mock.method(auth, "login", async () => ({ id: 1 }));
    const app = express();
    app.get("/metrics", auth.apiAuth, (_req, res) => res.end("local metrics"));
    const port = await listen(http.createServer(app), context);
    const headers = { Authorization: "Basic " + Buffer.from("test:correct-local-password").toString("base64") };
    for (let i = 0; i < 20; i++) {
        assert.equal((await request(port, "/metrics", headers)).status, 200);
    }
    assert.equal((await request(port, "/metrics", headers)).status, 401);
});

test("HTTP monitor bounds plain, chunked, compressed, OAuth and NTLM responses", async (context) => {
    const large = Buffer.alloc(10 * 1024 * 1024 + 1, 65);
    const compressed = gzipSync(large);
    const server = http.createServer((req, res) => {
        if (req.url === "/ok") {
            res.setHeader("Content-Type", "application/json");
            return res.end('{"status":"ready"}');
        }
        if (req.url === "/gzip") {
            res.setHeader("Content-Encoding", "gzip");
            return res.end(compressed);
        }
        if (req.url === "/plain") {
            res.setHeader("Content-Length", large.length);
        }
        res.write(large.subarray(0, large.length - 1));
        res.end(large.subarray(large.length - 1));
    });
    const port = await listen(server, context);
    for (const [route, method] of [
        ["/plain", "none"],
        ["/chunked", "none"],
        ["/gzip", "none"],
        ["/plain", "oauth2-cc"],
        ["/plain", "ntlm"],
    ]) {
        const httpAgent = new http.Agent();
        context.after(() => httpAgent.destroy());
        await assert.rejects(
            Monitor.prototype.makeAxiosRequest.call(
                { auth_method: method },
                {
                    url: `http://127.0.0.1:${port}${route}`,
                    proxy: false,
                    timeout: 5000,
                    httpAgent,
                    httpsAgent: new (require("node:https").Agent)(),
                }
            ),
            /maxContentLength/
        );
    }
    const response = await Monitor.prototype.makeAxiosRequest.call(
        { auth_method: "none" },
        {
            url: `http://127.0.0.1:${port}/ok`,
            proxy: false,
            timeout: 5000,
        }
    );
    assert.deepEqual(response.data, { status: "ready" });
});

test("SMS message delimiters cannot change recipients, API key or gateway", async (context) => {
    const SMSManager = require("../../server/notification-providers/smsmanager");
    const provider = new SMSManager();
    let captured;
    context.mock.method(provider, "getAxiosConfigWithProxy", (config) => ({
        ...config,
        adapter: async (value) => {
            captured = new URL(axios.getUri(value));
            return { data: "OK", status: 200, statusText: "OK", headers: {}, config: value };
        },
    }));
    const message = "ready&number=another-recipient# + = ?";
    await provider.send({ smsmanagerApiKey: "local&key", numbers: "+15550000000", messageType: "high" }, message);
    assert.equal(captured.searchParams.get("message"), message);
    assert.equal(captured.searchParams.get("number"), "+15550000000");
    assert.equal(captured.searchParams.get("apikey"), "local&key");
    assert.equal(captured.searchParams.get("gateway"), "high");
    assert.equal(captured.hash, "");
});

test("Aliyun SMS uses HTTPS before sending any form data", async (context) => {
    const provider = new (require("../../server/notification-providers/aliyun-sms"))();
    let captured;
    context.mock.method(provider, "getAxiosConfigWithProxy", (config) => ({
        ...config,
        adapter: async (value) => {
            captured = value;
            return { data: { Message: "OK" }, status: 200, statusText: "OK", headers: {}, config: value };
        },
    }));
    await provider.sendSms(
        { phonenumber: "+15550000000", secretAccessKey: "local-fixture" },
        '{"name":"local monitor"}'
    );
    assert.equal(new URL(captured.url).protocol, "https:");
    assert.equal(captured.maxRedirects, 0);
    assert.ok(new URLSearchParams(captured.data).get("Signature"));
});

test("RSS cache keeps Host and forwarded origins isolated", async (context) => {
    const StatusPage = require("../../server/model/status_page");
    context.mock.method(Settings, "get", async (name) => name === "trustProxy");
    context.mock.method(R, "findOne", async () => ({ title: "Local status" }));
    context.mock.method(StatusPage, "getRSSPageData", async () => ({
        incidents: [],
        heartbeats: [],
        statusDescription: "UP",
    }));
    const app = express();
    app.use(require("../../server/routers/status-page-router"));
    context.after(() => apicache.clear());
    const port = await listen(http.createServer(app), context);
    const first = await request(port, "/status/local/rss", { Host: "first.invalid" });
    const second = await request(port, "/status/local/rss", { Host: "owner.invalid" });
    const third = await request(port, "/status/local/rss", {
        Host: "owner.invalid",
        "X-Forwarded-Host": "forwarded.invalid",
        "X-Forwarded-Proto": "https",
    });
    assert.match(first.body, /first\.invalid/);
    assert.match(second.body, /owner\.invalid/);
    assert.doesNotMatch(second.body, /first\.invalid/);
    assert.match(third.body, /https:\/\/forwarded\.invalid/);
    assert.doesNotMatch(third.body, /owner\.invalid/);
});

test("legacy Kafka migration preserves enabled TLS and normalizes boolean representations", () => {
    const db = new (require("better-sqlite3"))(":memory:");
    try {
        db.exec(
            "CREATE TABLE monitor(id INTEGER PRIMARY KEY, kafka_producer_ssl, kafka_producer_allow_auto_topic_creation, sasl TEXT)"
        );
        const values = [
            [null, 0],
            [0, 0],
            [1, 1],
            [2, 1],
            [-1, 1],
            ["false", 0],
            ["true", 1],
            ["0", 0],
            [" FALSE ", 0],
            ["unknown", 1],
        ];
        values.forEach(([value], index) =>
            db.prepare("INSERT INTO monitor VALUES (?, ?, ?, 'retained')").run(index, value, value)
        );
        db.exec(
            fs.readFileSync(
                path.join(__dirname, "../../db/old_migrations/patch-fix-kafka-producer-booleans.sql"),
                "utf8"
            )
        );
        values.forEach(([, expected], index) => {
            const row = db.prepare("SELECT * FROM monitor WHERE id = ?").get(index);
            assert.equal(row.kafka_producer_ssl, expected);
            assert.equal(row.sasl, "retained");
        });
        assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    } finally {
        db.close();
    }
});

test("release preparation passes untrusted PR titles literally without a shell", async (context) => {
    const childProcess = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    const title = 'fix: literal $(printf LOCAL_TEST) `printf LOCAL_TEST` "quotes"';
    const parent = path.resolve(__dirname, "../../private");
    const directory = fs.mkdtempSync(path.join(parent, "release-cli-"));
    const packageRoot = path.join(directory, "node_modules", "opencode-ai");
    fs.mkdirSync(packageRoot, { recursive: true });
    const entry = path.join(packageRoot, "cli.js");
    fs.writeFileSync(path.join(directory, "opencode.cmd"), "@exit /b 99\r\n");
    fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "opencode-ai", bin: { opencode: "cli.js" } })
    );
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const previousPath = process.env.PATH;
    process.env.PATH = directory + path.delimiter + previousPath;
    context.after(() => {
        process.env.PATH = previousPath;
        assert.equal(path.dirname(directory), parent);
        assert.ok(path.basename(directory).startsWith("release-cli-"));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { resolveOpenCodeCommand } = await import("../../extra/release/generate-changelog.mjs");
    const [executable, ...leading] = resolveOpenCodeCommand("win32", directory);
    const literal = childProcess.spawnSync(executable, [...leading, title], { shell: false, encoding: "utf8" });
    assert.equal(literal.status, 0);
    assert.deepEqual(JSON.parse(literal.stdout), [title]);
    let captured;
    context.mock.method(childProcess, "spawnSync", (command, args, options) => {
        if (command === "opencode" || (command === process.execPath && args[0] === entry)) {
            captured = { args, options };
            return { status: 0, stdout: JSON.stringify({ type: "text", part: { text: '{"securityFixes":[42]}' } }) };
        }
        assert.equal(command, "gh");
        return {
            status: 0,
            stdout:
                args[1] === "list"
                    ? JSON.stringify([{ number: 42, title, author: { login: "local-fixture" } }])
                    : '{"commits":[]}',
        };
    });
    syncBuiltinESMExports();
    try {
        const { generateChangelogAI } = await import("../../extra/release/generate-changelog.mjs");
        const output = await generateChangelogAI("HEAD");
        assert.equal(captured.options.shell, false);
        assert.ok(captured.args.at(-1).includes(JSON.stringify(title).slice(1, -1)));
        assert.ok(output.includes("#42"));
    } finally {
        context.mock.restoreAll();
        syncBuiltinESMExports();
    }
});
