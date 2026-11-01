const { after, before, describe, test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const apicache = require("../../server/modules/apicache/apicache").newInstance();

/**
 * Request the test server.
 * @param {number} port Server port
 * @param {object} headers Request headers
 * @param {string} pathname Request path
 * @returns {Promise<import("node:http").IncomingMessage>} Server response
 */
function request(port, headers = {}, pathname = "/cached") {
    return new Promise((resolve, reject) => {
        const req = http.request({ port, path: pathname, headers, agent: false }, resolve);
        req.on("error", reject);
        req.end();
    });
}

describe("API cache", () => {
    let server;
    let port;

    before(async () => {
        const cache = apicache.middleware("1 minute");
        server = http.createServer((req, res) => {
            cache(req, res, () => {
                const body = "cached body";
                res.setHeader("Content-Type", "text/plain");
                res.setHeader("Content-Length", Buffer.byteLength(body));
                res.setHeader("ETag", '"cached"');
                res.end(body);
            });
        });
        await new Promise((resolve) => server.listen(0, resolve));
        port = server.address().port;
    });

    after(async () => {
        apicache.clear("/cached");
        await new Promise((resolve) => server.close(resolve));
    });

    test("cached response omits representation headers for a matching ETag", async () => {
        const warmResponse = await request(port);
        warmResponse.resume();
        await new Promise((resolve) => warmResponse.on("end", resolve));

        const response = await request(port, { "If-None-Match": '"cached"' });
        response.resume();

        assert.strictEqual(response.statusCode, 304);
        assert.strictEqual(response.headers.etag, '"cached"');
        assert.strictEqual(response.headers["content-length"], undefined);
        assert.strictEqual(response.headers["content-type"], undefined);
    });
});

/**
 * @param {number} port Port.
 * @param {string} route Route.
 * @returns {Promise<string>} Response body.
 */
async function read(port, route) {
    const response = await request(port, {}, route);
    const chunks = [];
    for await (const chunk of response) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
}

test("public cache bounds unique query keys and removes evicted group entries", async (context) => {
    const cache = apicache.newInstance();
    const middleware = cache.middleware("1 day");
    let calls = 0;
    const server = http.createServer((req, res) =>
        middleware(req, res, () => {
            req.apicacheGroup = "local-group";
            res.end("body " + ++calls);
        })
    );
    await new Promise((resolve) => server.listen(0, resolve));
    context.after(async () => {
        cache.clear();
        await new Promise((resolve) => server.close(resolve));
    });
    const port = server.address().port;
    for (let i = 0; i < 1010; i++) {
        await read(port, "/cached?nonce=" + i);
    }
    assert.equal(cache.getIndex().all.length, 1000);
    assert.equal(cache.getIndex("local-group").length, 1000);
    assert.equal(await read(port, "/cached?nonce=1009"), "body 1010");
    assert.equal(calls, 1010);
    assert.equal(await read(port, "/cached?nonce=0"), "body 1011");
    cache.clear("local-group");
    assert.equal(cache.getIndex().all.length, 0);
});

test("public cache bounds aggregate bytes and serves oversized/error responses without caching them", async (context) => {
    const cache = apicache.newInstance();
    const middleware = cache.middleware("1 day");
    const body = "x".repeat(900 * 1024);
    const oversized = "x".repeat(1024 * 1024 + 1);
    const server = http.createServer((req, res) =>
        middleware(req, res, () => {
            if (req.url === "/missing") {
                res.statusCode = 404;
                return res.end("not found");
            }
            res.end(req.url === "/oversized" ? oversized : body);
        })
    );
    await new Promise((resolve) => server.listen(0, resolve));
    context.after(async () => {
        cache.clear();
        await new Promise((resolve) => server.close(resolve));
    });
    const port = server.address().port;
    for (let i = 0; i < 50; i++) {
        assert.equal((await read(port, "/cached?nonce=" + i)).length, body.length);
    }
    assert.ok(cache.getIndex().all.length * Buffer.byteLength(body) <= 32 * 1024 * 1024);
    assert.equal((await read(port, "/oversized")).length, oversized.length);
    assert.equal(await read(port, "/missing"), "not found");
    assert.ok(!cache.getIndex().all.includes("/oversized"));
    assert.ok(!cache.getIndex().all.includes("/missing"));
});

test("memory-cache replacement cancels the previous expiry and keeps exact size", (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const cache = new (require("../../server/modules/apicache/memory-cache"))();
    cache.add("key", "old", 100);
    context.mock.timers.tick(60);
    cache.add("key", "new", 100);
    context.mock.timers.tick(50);
    assert.equal(cache.getValue("key"), "new");
    assert.equal(cache.size, 1);
    cache.clear();
    context.mock.timers.tick(100);
    assert.equal(cache.size, 0);
});
