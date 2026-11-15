const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");

const REQUEST_LIMIT = 262144;
const RESPONSE_LIMIT = 4194304;
const PROVIDER_LIMIT = 2097152;
const BODY_LIMIT = 131072;
const headerNames = ["authorization", "content-type", "accept", "openai-beta", "openai-organization", "openai-project"];

/**
 * @returns {Error} A credential-free transport failure.
 */
function failure() {
    return new Error("projectAIWorkerUnavailable");
}
/**
 * @param {unknown} value Operator input
 * @param {boolean} main Whether a private endpoint is required
 * @returns {object} Validated private configuration
 * @throws {Error} Invalid or unavailable private transport
 */
function configuration(value, main = false) {
    const expected = main ? "endpoint,label,secret,version,workerID" : "secret,version,workerID";
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== expected ||
        value.version !== 1 ||
        typeof value.workerID !== "string" ||
        !/^[a-zA-Z0-9_-]{8,48}$/.test(value.workerID) ||
        typeof value.secret !== "string" ||
        !/^[a-zA-Z0-9_-]{43}$/.test(value.secret)
    )
        throw failure();
    if (main) {
        const url = new URL(value.endpoint);
        const octets = url.hostname.split(".").map(Number);
        const privateAddress =
            net.isIP(url.hostname) === 4 &&
            (octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
        if (
            url.protocol !== "http:" ||
            !privateAddress ||
            url.username ||
            url.password ||
            !url.port ||
            Number(url.port) < 1024 ||
            url.pathname !== "/" ||
            url.search ||
            url.hash ||
            typeof value.label !== "string" ||
            value.label.length > 120 ||
            /[\u0000-\u001f\u007f]/.test(value.label)
        )
            throw failure();
    }
    return Object.freeze({ ...value });
}
/**
 * @param {string} file Explicit operator file
 * @param {boolean} main Main installation
 * @returns {object} No creation or permission weakening
 * @throws {Error} Invalid or unavailable private transport
 */
function readConfiguration(file, main = false) {
    const info = fs.lstatSync(file);
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 4096 ||
        (process.platform !== "win32" && info.mode & 0o077)
    )
        throw failure();
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 4096) throw failure();
        const buffer = Buffer.alloc(4097);
        let length = 0;
        while (length < buffer.length) {
            const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
            if (!count) break;
            length += count;
        }
        if (length > 4096) throw failure();
        return configuration(JSON.parse(buffer.subarray(0, length).toString("utf8")), main);
    } finally {
        fs.closeSync(descriptor);
    }
}
/**
 * @param {object} config Private identity
 * @param {string} purpose Separate encryption/signature use
 * @returns {Buffer} Derived key
 */
function key(config, purpose) {
    return Buffer.from(
        crypto.hkdfSync(
            "sha256",
            Buffer.from(config.secret, "base64url"),
            Buffer.alloc(0),
            "uptime-kuma:openai-worker:v1:" + purpose,
            32
        )
    );
}
/**
 * @param {string|Buffer} value Exact wire bytes
 * @returns {string} Digest
 */
function digest(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}
/**
 * @param {object} config Identity
 * @param {string} direction Request or response
 * @param {object} meta Bound message
 * @returns {Buffer} Authenticated context
 * @throws {Error} Invalid or unavailable private transport
 */
function context(config, direction, meta) {
    if (!["request", "response"].includes(direction)) throw failure();
    return Buffer.from(["uptime-kuma:openai-worker:v1", direction, config.workerID, meta.id, meta.nonce].join("\n"));
}
/**
 * @param {object} config Identity
 * @param {string} direction Purpose
 * @param {object} meta Message identity
 * @param {object} value Secret payload
 * @returns {string} Authenticated ciphertext
 * @throws {Error} Invalid or unavailable private transport
 */
function seal(config, direction, meta, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const maximum = direction === "request" ? 190000 : 3145728;
    if (bytes.length > maximum) throw failure();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key(config, "encryption"), iv);
    cipher.setAAD(context(config, direction, meta));
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return JSON.stringify({
        v: 1,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        data: data.toString("base64url"),
    });
}
/**
 * @param {object} config Identity
 * @param {string} direction Purpose
 * @param {object} meta Message identity
 * @param {string} wire Secret envelope
 * @returns {object} Authenticated payload
 * @throws {Error} Invalid or unavailable private transport
 */
function open(config, direction, meta, wire) {
    if (
        typeof wire !== "string" ||
        Buffer.byteLength(wire) > (direction === "request" ? REQUEST_LIMIT : RESPONSE_LIMIT)
    )
        throw failure();
    const value = JSON.parse(wire);
    if (
        !value ||
        Object.keys(value).sort().join(",") !== "data,iv,tag,v" ||
        value.v !== 1 ||
        typeof value.iv !== "string" ||
        !/^[a-zA-Z0-9_-]{16}$/.test(value.iv) ||
        typeof value.tag !== "string" ||
        !/^[a-zA-Z0-9_-]{22}$/.test(value.tag) ||
        typeof value.data !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(value.data)
    )
        throw failure();
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key(config, "encryption"),
        Buffer.from(value.iv, "base64url")
    );
    decipher.setAAD(context(config, direction, meta));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(value.data, "base64url")), decipher.final()]).toString("utf8")
    );
}
/**
 * @param {object} config Identity
 * @param {string} direction Purpose
 * @param {object} meta Header values
 * @returns {string} Closed canonical signature
 */
function signature(config, direction, meta) {
    const text = [
        "uptime-kuma:openai-worker:v1",
        direction,
        "POST",
        "/rpc",
        config.workerID,
        meta.id,
        meta.nonce,
        meta.timestamp,
        meta.digest,
    ].join("\n");
    return crypto.createHmac("sha256", key(config, "signature")).update(text).digest("hex");
}
/**
 * @param {object} config Identity
 * @param {string} direction Purpose
 * @param {object} meta Request identity
 * @param {string} wire Exact body
 * @param {number} now UTC time
 * @returns {object} Bounded headers
 */
function headers(config, direction, meta, wire, now = Date.now()) {
    const value = { ...meta, timestamp: now, digest: digest(wire) };
    return {
        "content-type": "application/octet-stream",
        "x-kuma-worker-id": config.workerID,
        "x-kuma-worker-request": value.id,
        "x-kuma-worker-nonce": value.nonce,
        "x-kuma-worker-time": String(value.timestamp),
        "x-kuma-worker-digest": value.digest,
        "x-kuma-worker-signature": signature(config, direction, value),
    };
}
/**
 * @param {object} config Identity
 * @param {string} direction Purpose
 * @param {object|Headers} source Untrusted headers
 * @param {object|null} expected Original request
 * @param {number} now UTC time
 * @returns {object} Authenticated headers; body must still match the digest
 * @throws {Error} Invalid or unavailable private transport
 */
function verifyHeaders(config, direction, source, expected = null, now = Date.now()) {
    const get = (name) => (typeof source.get === "function" ? source.get(name) : source[name]);
    const meta = {
        id: get("x-kuma-worker-request"),
        nonce: get("x-kuma-worker-nonce"),
        timestamp: Number(get("x-kuma-worker-time")),
        digest: get("x-kuma-worker-digest"),
    };
    const signed = get("x-kuma-worker-signature");
    if (
        get("x-kuma-worker-id") !== config.workerID ||
        typeof meta.id !== "string" ||
        !/^[a-f0-9]{32}$/.test(meta.id) ||
        typeof meta.nonce !== "string" ||
        !/^[a-zA-Z0-9_-]{43}$/.test(meta.nonce) ||
        !Number.isSafeInteger(meta.timestamp) ||
        Math.abs(now - meta.timestamp) > 60000 ||
        typeof meta.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(meta.digest) ||
        typeof signed !== "string" ||
        !/^[a-f0-9]{64}$/.test(signed) ||
        (expected && (meta.id !== expected.id || meta.nonce !== expected.nonce))
    )
        throw failure();
    if (!crypto.timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(signature(config, direction, meta), "hex")))
        throw failure();
    return meta;
}
/**
 * @param {unknown} value Decrypted, still untrusted fetch request
 * @returns {object} Fixed official origins, methods and bounded headers
 * @throws {Error} Invalid or unavailable private transport
 */
function validateRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
    if (value.action === "health" && Object.keys(value).join(",") === "action") return value;
    if (
        Object.keys(value).sort().join(",") !== "action,body,headers,method,url" ||
        value.action !== "fetch" ||
        !["GET", "POST"].includes(value.method) ||
        typeof value.url !== "string" ||
        value.url.length > 2048
    )
        throw failure();
    const url = new URL(value.url);
    if (
        !["https://auth.openai.com", "https://api.openai.com"].includes(url.origin) ||
        url.username ||
        url.password ||
        url.hash ||
        (url.origin === "https://api.openai.com" &&
            !url.pathname.startsWith("/v1/") &&
            !url.pathname.startsWith("/.well-known/"))
    )
        throw failure();
    if (
        !value.headers ||
        typeof value.headers !== "object" ||
        Array.isArray(value.headers) ||
        Object.entries(value.headers).some(
            ([name, text]) => !headerNames.includes(name) || typeof text !== "string" || /[\r\n\0]/.test(text)
        ) ||
        Buffer.byteLength(JSON.stringify(value.headers)) > 16384 ||
        (value.body !== null && (typeof value.body !== "string" || Buffer.byteLength(value.body) > BODY_LIMIT)) ||
        (value.method === "GET" && value.body !== null)
    )
        throw failure();
    return value;
}
/**
 * @param {ReadableStream|import('node:stream').Readable} body Byte stream
 * @param {number} maximum Byte limit
 * @returns {Promise<Buffer>} Exact bounded bytes
 */
async function readBytes(body, maximum) {
    const chunks = [];
    let length = 0;
    try {
        for await (const chunk of body) {
            const bytes = Buffer.from(chunk);
            length += bytes.length;
            if (length > maximum) throw failure();
            chunks.push(bytes);
        }
        return Buffer.concat(chunks);
    } catch (error) {
        await body.cancel?.().catch(() => {});
        throw error;
    }
}

module.exports = {
    REQUEST_LIMIT,
    RESPONSE_LIMIT,
    PROVIDER_LIMIT,
    BODY_LIMIT,
    configuration,
    readConfiguration,
    failure,
    digest,
    seal,
    open,
    headers,
    verifyHeaders,
    validateRequest,
    readBytes,
};
