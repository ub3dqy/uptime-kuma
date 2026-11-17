const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const protocol = require("./protocol");
let lastSeen = null;
let healthPromise = null;
let healthUntil = 0;
let healthValue = null;

/**
 * @returns {object|null} Operator-configured private route, absent in legacy local installations.
 * @throws {Error} Invalid or unavailable private transport
 */
function configuration() {
    const explicit = process.env.UPTIME_KUMA_AI_WORKER_CONFIG;
    const file = explicit || path.resolve(require("../database").dataDir || "data", "ai-worker/config.json");
    if (!explicit && !fs.existsSync(file)) return null;
    try {
        return protocol.readConfiguration(file, true);
    } catch {
        throw protocol.failure();
    }
}
/**
 * @param {object} config Private operator identity
 * @param {object} payload Closed request
 * @param {object} options Cancellation and isolated test transport
 * @returns {Promise<object>} Authenticated reply, without automatic retries
 */
async function rpc(config, payload, options = {}) {
    const meta = { id: crypto.randomBytes(16).toString("hex"), nonce: crypto.randomBytes(32).toString("base64url") };
    const body = protocol.seal(config, "request", meta, protocol.validateRequest(payload));
    options.signal?.throwIfAborted();
    const response = await (options.fetch || globalThis.fetch)(new URL("/rpc", config.endpoint).href, {
        method: "POST",
        redirect: "error",
        signal: options.signal || AbortSignal.timeout(120000),
        headers: protocol.headers(config, "request", meta, body),
        body,
    });
    const authenticated = protocol.verifyHeaders(config, "response", response.headers, meta);
    const bytes = await protocol.readBytes(response.body, protocol.RESPONSE_LIMIT);
    if (protocol.digest(bytes) !== authenticated.digest) throw protocol.failure();
    const value = protocol.open(config, "response", meta, bytes.toString("utf8"));
    lastSeen = Date.now();
    if (response.status !== 200 || !value || value.ok !== true) throw protocol.failure();
    return value;
}
/**
 * @param {object} config Private route
 * @param {Function} wireFetch Isolated test dependency
 * @returns {Function} Native-compatible bounded fetch over the dedicated AI service
 */
function remoteFetch(config, wireFetch = globalThis.fetch) {
    return async (input, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const headers = Object.fromEntries(new Headers(options.headers || {}));
        let body = options.body ?? null;
        if (body instanceof URLSearchParams) body = body.toString();
        const result = await rpc(
            config,
            { action: "fetch", url: String(input), method, headers, body },
            { signal: options.signal, fetch: wireFetch }
        );
        if (
            Object.keys(result).sort().join(",") !== "body,headers,ok,status" ||
            !Number.isSafeInteger(result.status) ||
            result.status < 200 ||
            result.status > 599 ||
            typeof result.body !== "string" ||
            !/^[a-zA-Z0-9+/]*={0,2}$/.test(result.body) ||
            !result.headers ||
            typeof result.headers !== "object" ||
            Array.isArray(result.headers) ||
            Object.entries(result.headers).some(
                ([name, value]) => name !== "content-type" || typeof value !== "string" || value.length > 256
            )
        ) {
            throw protocol.failure();
        }
        const bytes = Buffer.from(result.body, "base64");
        if (bytes.length > protocol.PROVIDER_LIMIT) throw protocol.failure();
        return new Response([204, 205, 304].includes(result.status) ? null : bytes, {
            status: result.status,
            headers: result.headers,
        });
    };
}
/**
 * @returns {Function} Existing project ownership, consent and budgets remain in the caller.
 */
function fetchForInstallation() {
    const config = configuration();
    return config ? remoteFetch(config) : globalThis.fetch;
}
/**
 * @returns {Promise<object>} A connection check to our own service; never a model request.
 */
async function status() {
    let config;
    try {
        config = configuration();
    } catch {
        return { enabled: true, connected: false, lastSeen: null };
    }
    if (!config) return { enabled: false };
    if (healthValue && Date.now() < healthUntil) return healthValue;
    if (!healthPromise) {
        healthPromise = (async () => {
            let connected = false;
            let providers = [];
            try {
                const result = await rpc(config, { action: "health" }, { signal: AbortSignal.timeout(4000) });
                connected = result.ready === true;
                if (connected) {
                    providers = ["openai"];
                    if (Array.isArray(result.providers) && result.providers.includes("anthropic")) {
                        providers.push("anthropic");
                    }
                }
            } catch {
                /* Preserve credentials and the last actual observation on a network failure. */
            }
            healthValue = { enabled: true, connected, label: config.label, lastSeen, providers };
            healthUntil = Date.now() + 15000;
            return healthValue;
        })().finally(() => {
            healthPromise = null;
        });
    }
    return healthPromise;
}

module.exports = { configuration, rpc, remoteFetch, fetchForInstallation, status };
