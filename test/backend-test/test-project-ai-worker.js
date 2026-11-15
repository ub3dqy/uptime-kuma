const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const protocol = require("../../server/ai-worker/protocol");
const { createWorker } = require("../../server/ai-worker/server");
const { remoteFetch, rpc } = require("../../server/ai-worker/transport");
const { OpenAIClient } = require("../../server/projects/openai-client");
const { fakeClient, grant, clientID, json, stream, completion, diagnosis } = require("../fixtures/openai-grant.cjs");

/**
 * @returns {object} Synthetic identity without external credentials
 */
function identity() {
    return { version: 1, workerID: "synthetic-worker", secret: crypto.randomBytes(32).toString("base64url") };
}
/**
 * @param {object} t Lifecycle
 * @param {Function} upstream No external network
 * @returns {Promise<object>} Restartable loopback service
 */
async function fixture(t, upstream) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-ai-worker-"));
    fs.chmodSync(directory, 0o700);
    const config = identity();
    let worker;
    const value = { directory, config };
    value.start = async () => {
        worker = createWorker({ config, directory, fetch: upstream });
        await new Promise((resolve, reject) => {
            worker.server.once("error", reject);
            worker.server.listen(0, "127.0.0.1", resolve);
        });
        value.main = protocol.configuration(
            { ...config, endpoint: "http://127.0.0.1:" + worker.server.address().port, label: "Test" },
            true
        );
    };
    value.stop = async () => {
        if (worker) {
            const previous = worker;
            worker = null;
            await previous.close();
        }
    };
    t.after(async () => {
        await value.stop();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await value.start();
    return value;
}
/**
 * @param {object} config Private identity
 * @param {object} payload Request
 * @param {object} meta Optional replay identity
 * @returns {object} Exact signed encrypted request
 */
function request(
    config,
    payload,
    meta = { id: crypto.randomBytes(16).toString("hex"), nonce: crypto.randomBytes(32).toString("base64url") }
) {
    const body = protocol.seal(config, "request", meta, payload);
    return { meta, body, headers: protocol.headers(config, "request", meta, body) };
}

test("private configuration and cryptographic envelopes reject public routes, tampering, reflection, stale timestamps and swapped replies", () => {
    const config = identity();
    for (const endpoint of [
        "https://example.test:19087",
        "http://example.test:19087",
        "http://192.0.2.1:19087",
        "http://127.0.0.1:80",
        "http://127.0.0.1:19087/rpc",
        "http://user:pass@127.0.0.1:19087",
    ]) {
        assert.throws(() => protocol.configuration({ ...config, endpoint, label: "Test" }, true));
    }
    const signed = request(config, { action: "health" });
    assert.equal(signed.body.includes("health"), false);
    assert.deepEqual(protocol.open(config, "request", signed.meta, signed.body), { action: "health" });
    assert.throws(() => protocol.open(config, "response", signed.meta, signed.body));
    assert.throws(() => protocol.open(identity(), "request", signed.meta, signed.body));
    const altered = JSON.parse(signed.body);
    altered.tag = "A".repeat(22);
    assert.throws(() => protocol.open(config, "request", signed.meta, JSON.stringify(altered)));
    assert.throws(() => protocol.verifyHeaders(config, "request", signed.headers, null, Date.now() + 61000));
    assert.throws(() => protocol.verifyHeaders(config, "response", signed.headers));
    const reply = protocol.headers(config, "response", signed.meta, signed.body);
    assert.throws(() => protocol.verifyHeaders(config, "response", reply, { ...signed.meta, id: "a".repeat(32) }));
});

test("service authenticates before forwarding, bounds destinations, methods, headers and request bodies, and health never calls OpenAI", async (t) => {
    let calls = 0;
    const service = await fixture(t, async () => {
        calls++;
        return json({ ok: true });
    });
    assert.equal(
        (await fetch(service.main.endpoint + "/rpc", { method: "POST", body: "not authenticated" })).status,
        403
    );
    const invalid = [
        { url: "http://127.0.0.1:22" },
        { url: "https://api.openai.com.evil.test/v1/models" },
        { url: "https://api.openai.com/v1/../../internal" },
        { url: "https://api.openai.com:444/v1/models" },
        { method: "DELETE" },
        { headers: { host: "localhost" } },
        { headers: { authorization: "Bearer x\r\nHost: x" } },
        { method: "POST", body: "x".repeat(protocol.BODY_LIMIT + 1) },
    ];
    for (const overrides of invalid) {
        const payload = {
            action: "fetch",
            url: "https://api.openai.com/v1/models",
            method: "GET",
            headers: {},
            body: null,
            ...overrides,
        };
        const signed = request(service.config, payload);
        assert.equal(
            (
                await fetch(service.main.endpoint + "/rpc", {
                    method: "POST",
                    headers: signed.headers,
                    body: signed.body,
                })
            ).status,
            403
        );
    }
    assert.equal((await rpc(service.main, { action: "health" })).ready, true);
    assert.equal(calls, 0);
});

test("existing OAuth validation, account catalogs, terminal SSE and revocation work through the private service without account mixing", async (t) => {
    const seen = [];
    const upstream = fakeClient((url, options) => {
        seen.push({ url, bearer: options.headers.authorization });
        if (url.endsWith("/models"))
            return json({ models: [{ visibility: "list", slug: "gpt-synthetic", display_name: "Synthetic" }] });
        if (url.endsWith("/responses")) return stream([{ type: "response.completed", response: completion() }], true);
        if (url.endsWith("/revoke")) return json({});
        if (url.endsWith("/no-content")) return new Response(null, { status: 204 });
    });
    const service = await fixture(t, upstream.fetch);
    const client = new OpenAIClient({ fetch: remoteFetch(service.main) });
    const secret = await client.validateTokens(grant(), { clientID, nonce: "test-nonce" });
    assert.equal(secret.subject, "synthetic-admin");
    const [one, two] = await Promise.all([
        client.models("synthetic-first-account", "subscription"),
        client.models("synthetic-second-account", "subscription"),
    ]);
    assert.equal(one[0].id, "gpt-synthetic");
    assert.deepEqual(one, two);
    const result = await client.diagnose(
        { mode: "subscription", model: "gpt-synthetic" },
        secret.access_token,
        { facts: [] },
        AbortSignal.timeout(5000)
    );
    assert.deepEqual(result.result, diagnosis);
    assert.equal(await client.revoke(secret), true);
    assert.equal(
        (await remoteFetch(service.main)("https://auth.openai.com/no-content", { method: "POST", body: "" })).status,
        204
    );
    assert.deepEqual(
        seen
            .filter((item) => item.url.endsWith("/models"))
            .map((item) => item.bearer)
            .sort(),
        ["Bearer synthetic-first-account", "Bearer synthetic-second-account"]
    );
    await service.stop();
    const bytes = fs.readFileSync(path.join(service.directory, "requests.sqlite"));
    for (const secret of [
        "synthetic-access-token",
        "synthetic-first-account",
        "synthetic-second-account",
        "synthetic-refresh-token",
        "No real service",
    ]) {
        assert.equal(bytes.includes(Buffer.from(secret)), false);
    }
});

test("replays are rejected across restart and interrupted requests remain uncertain without repeating upstream work", async (t) => {
    let calls = 0;
    const service = await fixture(t, async () => {
        calls++;
        return json({ data: [] });
    });
    const payload = {
        action: "fetch",
        url: "https://api.openai.com/v1/models",
        method: "GET",
        headers: {},
        body: null,
    };
    const signed = request(service.config, payload);
    const send = (value) =>
        fetch(service.main.endpoint + "/rpc", { method: "POST", headers: value.headers, body: value.body });
    assert.equal((await send(signed)).status, 200);
    assert.equal((await send(signed)).status, 403);
    await service.stop();
    const db = new Database(path.join(service.directory, "requests.sqlite"));
    const interruptedID = "b".repeat(32);
    db.prepare("INSERT INTO requests(id, created_at, status) VALUES (?, ?, 'running')").run(interruptedID, Date.now());
    db.close();
    await service.start();
    assert.equal(
        (
            await send(
                request(service.config, payload, {
                    ...signed.meta,
                    nonce: crypto.randomBytes(32).toString("base64url"),
                })
            )
        ).status,
        403
    );
    assert.equal(
        (
            await send(
                request(service.config, payload, {
                    id: interruptedID,
                    nonce: crypto.randomBytes(32).toString("base64url"),
                })
            )
        ).status,
        403
    );
    assert.equal(calls, 1);
    await service.stop();
    const retained = new Database(path.join(service.directory, "requests.sqlite"), { readonly: true });
    assert.equal(retained.prepare("SELECT status FROM requests WHERE id = ?").get(interruptedID).status, "uncertain");
    retained.close();
});

test("client cancellation aborts upstream and records uncertainty without retries", async (t) => {
    let calls = 0;
    const started = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const service = await fixture(t, async (url, options) => {
        calls++;
        started.resolve();
        return new Promise((resolve, reject) => {
            options.signal.addEventListener(
                "abort",
                () => {
                    aborted.resolve();
                    reject(options.signal.reason);
                },
                { once: true }
            );
        });
    });
    const controller = new AbortController();
    const operation = remoteFetch(service.main)("https://api.openai.com/v1/responses", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
    });
    const rejected = assert.rejects(operation);
    await started.promise;
    controller.abort();
    await rejected;
    const deadline = setTimeout(() => aborted.reject(new Error("Upstream did not abort")), 3000);
    try {
        await aborted.promise;
    } finally {
        clearTimeout(deadline);
    }
    assert.equal(calls, 1);
});

test("oversized provider responses fail closed and partial SSE never becomes a completed diagnosis", async (t) => {
    let calls = 0;
    const service = await fixture(t, async () => {
        calls++;
        if (calls === 1) return new Response("x".repeat(protocol.PROVIDER_LIMIT + 1));
        return stream([{ type: "response.output_text.delta", delta: JSON.stringify(diagnosis) }]);
    });
    const client = new OpenAIClient({ fetch: remoteFetch(service.main) });
    await assert.rejects(client.models("synthetic", "subscription"));
    await assert.rejects(
        client.diagnose({ mode: "subscription", model: "gpt-synthetic" }, "synthetic", {}, AbortSignal.timeout(3000)),
        /incomplete/
    );
    assert.equal(calls, 2);
});

test("a forged or altered reply is rejected even when its outer HTTP status is successful", async () => {
    const config = protocol.configuration({ ...identity(), endpoint: "http://127.0.0.1:19087", label: "Test" }, true);
    let sent = 0;
    const client = remoteFetch(config, async () => {
        sent++;
        return json({ ok: true });
    });
    await assert.rejects(client("https://api.openai.com/v1/models"), /projectAIWorkerUnavailable/);
    assert.equal(sent, 1);
});

test("the service bounds concurrent provider work without silently queueing or retrying excess requests", async (t) => {
    let calls = 0;
    const started = Promise.withResolvers();
    const service = await fixture(t, async (url, options) => {
        if (++calls === 4) started.resolve();
        return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
    });
    const controller = new AbortController();
    const operations = Array.from({ length: 4 }, () =>
        assert.rejects(remoteFetch(service.main)("https://api.openai.com/v1/models", { signal: controller.signal }))
    );
    await started.promise;
    await assert.rejects(remoteFetch(service.main)("https://api.openai.com/v1/models"), /projectAIWorkerUnavailable/);
    assert.equal(calls, 4);
    controller.abort();
    await Promise.all(operations);
});

test("operator configuration is bounded and must remain an ordinary private single-link file", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-ai-config-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "config.json");
    const config = identity();
    fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(protocol.readConfiguration(filename), config);
    fs.linkSync(filename, path.join(directory, "second-link"));
    assert.throws(() => protocol.readConfiguration(filename));
    fs.unlinkSync(path.join(directory, "second-link"));
    fs.writeFileSync(filename, " ".repeat(4097));
    assert.throws(() => protocol.readConfiguration(filename));
    if (process.platform !== "win32") {
        fs.writeFileSync(filename, JSON.stringify(config));
        fs.chmodSync(filename, 0o644);
        assert.throws(() => protocol.readConfiguration(filename));
    }
});
