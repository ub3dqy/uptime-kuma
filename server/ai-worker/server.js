const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const Database = require("better-sqlite3");
const protocol = require("./protocol");

/**
 * Retain a bounded response through its terminal event, even if the provider keeps the connection open.
 * The project client still validates the completed result and distinguishes failed/incomplete events.
 * @param {Response} response Provider response
 * @param {object} request Validated operation
 * @returns {Promise<Buffer>} Bounded original response bytes
 */
async function providerBytes(response, request) {
    if (!response.body) return Buffer.alloc(0);
    const contentType = response.headers.get("content-type");
    const streaming =
        response.ok &&
        request.method === "POST" &&
        new URL(request.url).pathname === "/v1/responses" &&
        (!contentType || contentType.split(";")[0].trim().toLowerCase() === "text/event-stream");
    if (!streaming) return protocol.readBytes(response.body, protocol.PROVIDER_LIMIT);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks = [];
    let length = 0;
    let pending = "";
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) return Buffer.concat(chunks);
            length += part.value.byteLength;
            if (length > protocol.PROVIDER_LIMIT) throw protocol.failure();
            chunks.push(Buffer.from(part.value));
            pending += decoder.decode(part.value, { stream: true });
            pending = pending.replace(/\r\n/g, "\n");
            for (;;) {
                const end = pending.indexOf("\n\n");
                if (end < 0) break;
                const block = pending.slice(0, end);
                pending = pending.slice(end + 2);
                const data = block
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (!data || data === "[DONE]") continue;
                const event = JSON.parse(data);
                if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) {
                    return Buffer.concat(chunks);
                }
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

/**
 * Only fixed OpenAI HTTPS operations are accepted. No shell, file tools or project API exists here.
 * @param {object} options Private identity, retained metadata and isolated test dependencies
 * @returns {object} HTTP service and orderly shutdown
 * @throws {Error} Invalid or unavailable private transport
 */
function createWorker(options) {
    const config = protocol.configuration(options.config);
    const directory = path.resolve(options.directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && info.mode & 0o077))
        throw protocol.failure();
    const filename = path.join(directory, "requests.sqlite");
    if (fs.existsSync(filename) && (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).nlink !== 1))
        throw protocol.failure();
    const db = new Database(filename);
    fs.chmodSync(filename, 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, finished_at INTEGER,
            status TEXT NOT NULL, http_status INTEGER, error_code TEXT
        );
        UPDATE requests SET status = 'uncertain', error_code = 'interrupted' WHERE status = 'running';
    `);
    const nonceExists = db.prepare("SELECT 1 FROM nonces WHERE nonce = ?");
    const requestExists = db.prepare("SELECT 1 FROM requests WHERE id = ?");
    const retain = db.transaction((meta, action) => {
        db.prepare("DELETE FROM nonces WHERE expires_at < ?").run(Date.now());
        db.prepare("INSERT INTO nonces(nonce, expires_at) VALUES (?, ?)").run(meta.nonce, Date.now() + 120000);
        if (action === "fetch")
            db.prepare("INSERT INTO requests(id, created_at, status) VALUES (?, ?, 'running')").run(
                meta.id,
                Date.now()
            );
    });
    const finish = db.prepare(
        "UPDATE requests SET status = ?, finished_at = ?, http_status = ?, error_code = ? WHERE id = ?"
    );
    const controllers = new Set();
    const tasks = new Set();
    let closing = false;
    let windowStart = Date.now();
    let requests = 0;

    /**
     * @param {object} response HTTP output
     * @param {object} meta Authenticated request
     * @param {object} value Closed reply
     * @param {number} status HTTP code
     * @returns {void} Signed encrypted reply
     */
    function reply(response, meta, value, status = 200) {
        if (response.destroyed || response.writableEnded) return;
        const body = protocol.seal(config, "response", meta, value);
        response.writeHead(status, {
            ...protocol.headers(config, "response", meta, body),
            "cache-control": "no-store",
        });
        response.end(body);
    }
    /**
     * @param {object} request HTTP input
     * @param {object} response HTTP output
     * @returns {Promise<void>} One authenticated operation, no replay
     */
    async function handle(request, response) {
        if (request.method === "GET" && request.url === "/health") {
            response.writeHead(closing ? 503 : 200, {
                "content-type": "application/json",
                "cache-control": "no-store",
            });
            response.end(JSON.stringify({ ready: !closing }));
            return;
        }
        let meta;
        try {
            if (closing || request.method !== "POST" || request.url !== "/rpc") throw protocol.failure();
            meta = protocol.verifyHeaders(config, "request", request.headers);
            if (nonceExists.get(meta.nonce) || requestExists.get(meta.id)) throw protocol.failure();
            if (Date.now() - windowStart > 60000) {
                windowStart = Date.now();
                requests = 0;
            }
            if (++requests > 120) throw protocol.failure();
        } catch {
            response.writeHead(403, { connection: "close", "cache-control": "no-store" });
            response.end();
            return;
        }
        let value;
        try {
            const wire = await protocol.readBytes(request, protocol.REQUEST_LIMIT);
            if (protocol.digest(wire) !== meta.digest) throw protocol.failure();
            value = protocol.validateRequest(protocol.open(config, "request", meta, wire.toString("utf8")));
            retain(meta, value.action);
        } catch {
            reply(response, meta, { ok: false, code: "invalid" }, 403);
            return;
        }
        if (value.action === "health") {
            reply(response, meta, { ok: true, ready: true });
            return;
        }
        if (controllers.size >= 4) {
            finish.run("failed", Date.now(), null, "busy", meta.id);
            reply(response, meta, { ok: false, code: "busy" }, 503);
            return;
        }
        const controller = new AbortController();
        controllers.add(controller);
        const disconnect = () => {
            if (!response.writableEnded) controller.abort();
        };
        response.once("close", disconnect);
        try {
            const upstream = await (options.fetch || globalThis.fetch)(value.url, {
                method: value.method,
                headers: value.headers,
                body: value.body === null ? undefined : value.body,
                redirect: "error",
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
            });
            const bytes = await providerBytes(upstream, value);
            if (controller.signal.aborted) throw protocol.failure();
            const contentType = upstream.headers.get("content-type");
            const headers = contentType ? { "content-type": contentType.slice(0, 256) } : {};
            finish.run("completed", Date.now(), upstream.status, null, meta.id);
            reply(response, meta, { ok: true, status: upstream.status, headers, body: bytes.toString("base64") });
        } catch {
            finish.run(
                "uncertain",
                Date.now(),
                null,
                controller.signal.aborted ? "interrupted" : "unavailable",
                meta.id
            );
            reply(response, meta, { ok: false, code: "uncertain" }, 502);
        } finally {
            response.removeListener("close", disconnect);
            controllers.delete(controller);
        }
    }
    const server = http.createServer((request, response) => {
        const task = handle(request, response).catch(() => {
            if (!response.headersSent && !response.destroyed) response.writeHead(503, { connection: "close" });
            if (!response.destroyed && !response.writableEnded) response.end();
        });
        tasks.add(task);
        task.then(
            () => tasks.delete(task),
            () => tasks.delete(task)
        );
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 32;

    /**
     * @returns {Promise<void>} Abort before shutdown; retained started work is never replayed.
     */
    async function close() {
        closing = true;
        for (const controller of controllers) controller.abort();
        server.closeIdleConnections();
        const stopped = new Promise((resolve) => server.close(resolve));
        await Promise.allSettled([...tasks]);
        server.closeAllConnections();
        await stopped;
        db.close();
    }
    return { server, close };
}

module.exports = { createWorker };
