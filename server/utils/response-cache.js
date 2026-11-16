const CachePolicy = require("http-cache-semantics");
const fresh = require("fresh");

const MAX_ENTRIES = 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 2048;
const originHeaders = ["host", "x-forwarded-host", "x-forwarded-proto"];
const bypassHeaders = ["authorization", "cookie", "range", "if-match", "if-unmodified-since", "if-range"];
const noStoreDirective = /(?:^|,)\s*no-store\s*(?:,|$)/i;
const strippedHeaders = new Set([
    "age",
    "cache-control",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

/**
 * Keep the public response cache separate from the browser or an intermediary.
 * Based on the response cache introduced by Uptime Kuma in #8080.
 * @returns {{middleware: Function, clear: Function}} A cache and its invalidation hook.
 */
function createCache() {
    const entries = new Map();
    let bytes = 0;
    let generation = 0;

    /**
     * @param {string} key Cache key.
     * @returns {void}
     */
    function remove(key) {
        const entry = entries.get(key);
        if (entry) {
            bytes -= entry.bytes;
            entries.delete(key);
        }
    }

    /** @returns {void} */
    function clear() {
        generation++;
        entries.clear();
        bytes = 0;
    }

    /**
     * Cache completed public GET responses; streaming and private responses pass through.
     * @param {string} duration Cache duration in minutes.
     * @returns {Function} HTTP middleware.
     * @throws {Error} If the duration is invalid.
     */
    function middleware(duration) {
        const match = /^(\d+) minutes?$/.exec(duration);
        const seconds = Number(match?.[1]) * 60;
        if (!Number.isSafeInteger(seconds * 1000) || seconds <= 0) {
            throw new Error(`Invalid cache duration: ${duration}`);
        }

        return (req, res, next) => {
            const url = req.originalUrl || req.url;
            const origins = originHeaders.map((name) => req.headers[name] ?? "");
            const key = JSON.stringify([req.protocol || (req.socket.encrypted ? "https" : "http"), ...origins, url]);
            const keyBytes = Buffer.byteLength(key);
            if (
                req.method !== "GET" ||
                keyBytes > MAX_KEY_BYTES ||
                bypassHeaders.some((header) => req.headers[header] !== undefined) ||
                noStoreDirective.test(req.headers["cache-control"] || "")
            ) {
                res.setHeader("cache-control", "no-store");
                return next();
            }

            const keyHeaders = Object.fromEntries(originHeaders.map((name, i) => [name, origins[i]]));
            const requestView = { url, method: "GET", headers: { ...req.headers, ...keyHeaders } };
            const entry = entries.get(key);
            if (entry && entry.expires <= Date.now()) {
                remove(key);
            } else if (entry && entry.policy.satisfiesWithoutRevalidation(requestView)) {
                for (const [name, value] of Object.entries(entry.headers)) {
                    res.setHeader(name, value);
                }
                res.setHeader("cache-control", "no-store");
                if (fresh(req.headers, entry.headers)) {
                    res.statusCode = 304;
                    for (const name of ["content-type", "content-length", "content-encoding", "content-range"]) {
                        res.removeHeader(name);
                    }
                    return res.end();
                }
                return res.end(entry.body);
            }

            const started = generation;
            const end = res.end;
            res.end = function (chunk, encoding, callback) {
                if (!res.headersSent) {
                    const headers = res.getHeaders();
                    res.setHeader("cache-control", "no-store");
                    const length =
                        typeof chunk === "string" || chunk instanceof Uint8Array
                            ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined)
                            : 0;
                    const vary = String(headers.vary || "")
                        .toLowerCase()
                        .split(",")
                        .map((name) => name.trim());
                    if (
                        started === generation &&
                        res.statusCode === 200 &&
                        length > 0 &&
                        length + keyBytes <= MAX_ENTRY_BYTES &&
                        headers["set-cookie"] === undefined &&
                        headers.connection === undefined &&
                        headers["content-range"] === undefined &&
                        vary.every((name) => !name || originHeaders.includes(name))
                    ) {
                        // Do not keep arbitrary request headers in a stored entry.
                        const storedHeaders = Object.fromEntries(
                            Object.entries(headers).filter(([name]) => !strippedHeaders.has(name))
                        );
                        const size = length + keyBytes + Buffer.byteLength(JSON.stringify(storedHeaders));
                        if (size <= MAX_ENTRY_BYTES) {
                            const policy = new CachePolicy(
                                { ...requestView, headers: keyHeaders },
                                {
                                    status: 200,
                                    headers: {
                                        ...storedHeaders,
                                        "cache-control": headers["cache-control"] ?? `max-age=${seconds}`,
                                    },
                                }
                            );
                            if (policy.storable() && policy.timeToLive() > 0) {
                                remove(key);
                                while (entries.size >= MAX_ENTRIES || bytes + size > MAX_BYTES) {
                                    remove(entries.keys().next().value);
                                }
                                const body =
                                    typeof chunk === "string"
                                        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined)
                                        : Buffer.from(chunk);
                                entries.set(key, {
                                    body,
                                    policy,
                                    headers: storedHeaders,
                                    bytes: size,
                                    expires: Date.now() + seconds * 1000,
                                });
                                bytes += size;
                            }
                        }
                    }
                }
                return end.call(this, chunk, encoding, callback);
            };
            return next();
        };
    }

    return { middleware, clear };
}

module.exports = { ...createCache(), createCache };
