const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createCache } = require("../../server/utils/response-cache");

/**
 * @param {object} context Test context.
 * @param {Function} handler Handler behind the cache.
 * @returns {Promise<object>} Request function and invalidation hook.
 */
async function fixture(context, handler) {
    const cache = createCache();
    const middleware = cache.middleware("1 minute");
    const server = http.createServer((req, res) => middleware(req, res, () => handler(req, res)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    return {
        clear: cache.clear,
        request(path = "/status", headers = {}, method = "GET") {
            return new Promise((resolve, reject) => {
                const req = http.request(
                    { hostname: "127.0.0.1", port: server.address().port, path, headers, method, agent: false },
                    async (response) => {
                        try {
                            const chunks = [];
                            for await (const chunk of response) {
                                chunks.push(chunk);
                            }
                            resolve({
                                status: response.statusCode,
                                headers: response.headers,
                                body: Buffer.concat(chunks),
                            });
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
                req.on("error", reject);
                req.end();
            });
        },
    };
}

test("public responses stay separated by origin and support conditional requests", async (context) => {
    let calls = 0;
    const { request } = await fixture(context, (req, res) => {
        res.setHeader("content-type", "text/plain");
        res.setHeader("etag", 'W/"local-status"');
        res.setHeader("vary", "Host, X-Forwarded-Host, X-Forwarded-Proto");
        res.end(`${req.headers["x-forwarded-host"] || req.headers.host} ${++calls}`);
    });
    const first = await request("/status", { Host: "one.invalid" });
    const hit = await request("/status", { Host: "one.invalid" });
    const second = await request("/status", { Host: "two.invalid" });
    const forwarded = await request("/status", { Host: "one.invalid", "X-Forwarded-Host": "two.invalid" });
    assert.equal(first.body.toString(), "one.invalid 1");
    assert.equal(hit.body.toString(), "one.invalid 1");
    assert.equal(hit.headers["cache-control"], "no-store");
    assert.equal(second.body.toString(), "two.invalid 2");
    assert.equal(forwarded.body.toString(), "two.invalid 3");

    const conditional = await request("/status", { Host: "one.invalid", "If-None-Match": '"other", "local-status"' });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.etag, 'W/"local-status"');
    assert.equal(conditional.headers["content-type"], undefined);
    assert.equal(conditional.body.length, 0);
    assert.equal(calls, 3);
    assert.equal(
        (await request("/status", { Host: "one.invalid", "Cache-Control": "no-cache" })).body.toString(),
        "one.invalid 4"
    );
});

test("errors, personalized responses and streaming bodies are served without sharing", async (context) => {
    let calls = 0;
    const { request } = await fixture(context, (req, res) => {
        calls++;
        if (req.url === "/cookie") {
            res.setHeader("set-cookie", "local=1");
        } else if (req.url === "/private") {
            res.setHeader("cache-control", "private, max-age=60");
        } else if (req.url === "/language") {
            res.setHeader("vary", "Accept-Language");
        } else if (req.url === "/missing") {
            res.statusCode = 404;
        } else if (req.url === "/stream") {
            res.write("stream ");
        }
        res.end(String(calls));
    });
    for (const path of ["/cookie", "/private", "/language", "/missing", "/stream"]) {
        const first = await request(path);
        const second = await request(path);
        assert.notEqual(first.body.toString(), second.body.toString(), path);
        assert.equal(first.status, path === "/missing" ? 404 : 200, path);
        if (path === "/stream") {
            assert.match(first.body.toString(), /^stream \d+$/);
        }
    }
    const normal = await request();
    assert.notEqual((await request("/status", { Cookie: "mine=1" })).body.toString(), normal.body.toString());
    assert.notEqual(
        (await request("/status", { Authorization: "Bearer fixture" })).body.toString(),
        normal.body.toString()
    );
    assert.notEqual((await request("/status", {}, "POST")).body.toString(), normal.body.toString());
    assert.equal((await request()).body.toString(), normal.body.toString());
});

test("clearing the cache also discards a response in flight and expired entries are refreshed", async (context) => {
    let finish;
    let started;
    let calls = 0;
    const pending = new Promise((resolve) => {
        started = resolve;
    });
    const { request, clear } = await fixture(context, (_req, res) => {
        const current = String(++calls);
        if (calls === 1) {
            finish = () => res.end(current);
            started();
            return;
        }
        res.end(current);
    });
    const old = request();
    await pending;
    clear();
    finish();
    assert.equal((await old).body.toString(), "1");
    assert.equal((await request()).body.toString(), "2");
    assert.equal((await request()).body.toString(), "2");
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    context.mock.timers.tick(61000);
    assert.equal((await request()).body.toString(), "3");
});

test("many public URLs and large replies keep the cache within its original limits", async (context) => {
    const big = Buffer.alloc(900 * 1024, 1);
    const oversized = Buffer.alloc(1024 * 1024 + 1, 1);
    const visits = new Map();
    const { request } = await fixture(context, (req, res) => {
        visits.set(req.url, 1 + (visits.get(req.url) || 0));
        res.end(req.url.startsWith("/big") ? big : req.url === "/large" ? oversized : "small");
    });
    for (let index = 0; index < 1001; index++) {
        await request(`/small?i=${index}`);
    }
    await request("/small?i=1000");
    await request("/small?i=0");
    assert.equal(visits.get("/small?i=1000"), 1);
    assert.equal(visits.get("/small?i=0"), 2);
    for (let index = 0; index < 40; index++) {
        assert.equal((await request(`/big?i=${index}`)).body.length, big.length);
    }
    await request("/big?i=39");
    await request("/big?i=0");
    assert.equal(visits.get("/big?i=39"), 1);
    assert.equal(visits.get("/big?i=0"), 2);
    for (let index = 0; index < 2; index++) {
        assert.equal((await request("/large")).body.length, oversized.length);
        await request("/long?key=" + "a".repeat(2048));
    }
    assert.equal(visits.get("/large"), 2);
    assert.equal(visits.get("/long?key=" + "a".repeat(2048)), 2);
});
