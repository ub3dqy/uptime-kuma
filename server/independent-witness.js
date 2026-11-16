const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const path = require("node:path");
const { R } = require("redbean-node");
const { problem } = require("./projects/access");
const { sitesText, validSites, retainSites } = require("./witness-sites");
let cachedPath;
let cachedConfig;

/**
 * @returns {object|null} Operator-provisioned identity; never returned to a browser
 * @throws {Error} Unsafe or malformed operator configuration
 */
function configuration() {
    const explicit = process.env.UPTIME_KUMA_WITNESS_CONFIG;
    const file = explicit || path.resolve(require("./database").dataDir || "data", "witness/config.json");
    if (!explicit && !fs.existsSync(file)) return null;
    if (cachedPath === file) return cachedConfig;
    const stat = fs.lstatSync(file);
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 4096 ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
        throw new Error("Invalid witness configuration");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
        value.version !== 1 ||
        !/^[a-zA-Z0-9_-]{8,48}$/.test(value.nodeID) ||
        !/^[a-zA-Z0-9_-]{43}$/.test(value.secret) ||
        typeof value.label !== "string" ||
        value.label.length > 120 ||
        /[\u0000-\u001f\u007f]/.test(value.label)
    )
        throw new Error("Invalid witness configuration");
    cachedPath = file;
    cachedConfig = { ...value, hash: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
    return cachedConfig;
}
/**
 * @param {object} value Signed closed request
 * @returns {string} Canonical request shared with the independent implementation
 */
function requestText(value) {
    return [
        value.sites ? "uptime-kuma-witness/request/v2" : "uptime-kuma-witness/request/v1",
        value.nodeID,
        value.timestamp,
        value.nonce,
        value.channels.join(","),
        ...(value.sites ? [sitesText(value.sites)] : []),
    ].join("\n");
}
/**
 * @param {object} config Operator identity
 * @param {string} value Canonical message
 * @returns {string} Authentication code
 */
function sign(config, value) {
    return crypto.createHmac("sha256", Buffer.from(config.secret, "base64url")).update(value).digest("hex");
}
/**
 * @param {object} input Untrusted request
 * @param {object} config Operator identity
 * @param {number} now UTC time
 * @returns {boolean} Closed schema and constant-time authentication
 */
function valid(input, config, now = Date.now()) {
    if (
        !config ||
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        !["channels,nodeID,nonce,signature,timestamp", "channels,nodeID,nonce,signature,sites,timestamp"].includes(
            Object.keys(input).sort().join(",")
        ) ||
        (Object.hasOwn(input, "sites") && !validSites(input.sites, input.timestamp)) ||
        input.nodeID !== config.nodeID ||
        !Number.isSafeInteger(input.timestamp) ||
        Math.abs(now - input.timestamp) > 60000 ||
        typeof input.nonce !== "string" ||
        !/^[a-zA-Z0-9_-]{43}$/.test(input.nonce) ||
        typeof input.signature !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.signature) ||
        !Array.isArray(input.channels) ||
        input.channels.length > 2 ||
        input.channels.some((channel) => !["email", "telegram"].includes(channel)) ||
        new Set(input.channels).size !== input.channels.length ||
        [...input.channels].sort().join(",") !== input.channels.join(",")
    )
        return false;
    return crypto.timingSafeEqual(
        Buffer.from(input.signature, "hex"),
        Buffer.from(sign(config, requestText(input)), "hex")
    );
}
/**
 * @param {object} input Authenticated probe
 * @param {object} config Operator identity
 * @param {object} db Database
 * @returns {Promise<object>} Database readiness and response bound to this nonce
 */
async function accept(input, config, db = R.knex) {
    if (!valid(input, config)) throw problem();
    const now = Date.now();
    await db.transaction(async (tx) => {
        await tx("witness_nonce").where("expires_at", "<", now).delete();
        await tx("witness_nonce").insert({ nonce: input.nonce, expires_at: now + 120000 });
        await tx("witness_state")
            .insert({
                node_id: config.nodeID,
                config_hash: config.hash,
                last_seen: now,
                channels: input.channels.join(","),
            })
            .onConflict("node_id")
            .merge();
        await retainSites(tx, config, input.sites);
    });
    return {
        version: 1,
        nodeID: config.nodeID,
        nonce: input.nonce,
        timestamp: now,
        ready: true,
        signature: sign(config, ["uptime-kuma-witness/response/v1", requestText(input), now, "ready=1"].join("\n")),
    };
}
/**
 * @param {number} userID Current human
 * @returns {Promise<object>} Installation administrators only, no secret or remote access token
 */
async function status(userID) {
    const permitted = async () => {
        const actor = await R.knex("user")
            .where({ id: userID, active: 1, project_only: 0, service_account: 0 })
            .first();
        if (!actor) throw problem();
    };
    await permitted();
    const config = configuration();
    if (!config) return { configured: false, state: "not_configured", channels: [] };
    const row = await R.knex("witness_state").where({ node_id: config.nodeID, config_hash: config.hash }).first();
    await permitted();
    return {
        configured: true,
        label: config.label,
        state: row && Date.now() - Number(row.last_seen) <= 120000 ? "connected" : "missing",
        lastSeen: row ? Number(row.last_seen) : null,
        channels: row?.channels ? row.channels.split(",") : [],
    };
}
/** @returns {object} A dedicated bounded endpoint, unrelated to login or project data. */
function router() {
    const result = express.Router();
    let windowStart = Date.now();
    let requests = 0;
    result.post(
        "/api/independent-witness/probe",
        express.json({ limit: "4kb", strict: true }),
        async (request, response) => {
            response.setHeader("Cache-Control", "no-store");
            try {
                const config = configuration();
                if (!valid(request.body, config)) {
                    response.status(403).json({ ok: false });
                    return;
                }
                if (Date.now() - windowStart > 60000) {
                    windowStart = Date.now();
                    requests = 0;
                }
                if (++requests > 120) {
                    response.status(429).json({ ok: false });
                    return;
                }
                response.json(await accept(request.body, config));
            } catch {
                response.status(403).json({ ok: false });
            }
        }
    );
    return result;
}
module.exports = { router, status, valid, sign, requestText, accept, configuration };
