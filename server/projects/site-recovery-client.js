const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { Client } = require("ssh2");
const { protectedLocation } = require("./vault");
const { problem } = require("./access");
let override;

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const actions = ["restart_service", "restore_index"];
const codeArguments = {
    code_index: [],
    code_source: ["jobID", "paths"],
    code_stage: ["jobID", "source", "patch"],
    code_status: ["jobID"],
    code_backup: ["jobID", "sourceHash", "planHash", "patchHash", "qualificationHash", "approvedAt"],
    code_apply: ["jobID", "sourceHash", "planHash", "patchHash", "qualificationHash", "approvedAt"],
    code_rollback: ["jobID", "sourceHash", "planHash", "patchHash", "qualificationHash", "approvedAt"],
    code_export: ["jobID"],
};
const operations = ["inspect", "backup", "apply", "rollback", "status", ...Object.keys(codeArguments)];

/**
 * @param {string} filename Protected installation asset
 * @param {number} limit Bound
 * @returns {Buffer} Checked bytes
 * @throws {Error} Unprotected installation asset
 */
function privateFile(filename, limit = 65536) {
    const absolute = path.resolve(filename);
    if (fs.realpathSync(absolute) !== absolute) throw problem("projectSiteRecoveryPolicy");
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const info = fs.fstatSync(fd);
        if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.size > limit ||
            (process.platform !== "win32" && (info.mode & 0o077 || ![0, process.geteuid()].includes(info.uid)))
        ) {
            throw problem("projectSiteRecoveryPolicy");
        }
        const value = fs.readFileSync(fd);
        if (value.length > limit) throw problem("projectSiteRecoveryPolicy");
        return value;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * @returns {object|null} Closed installer-owned policy; model/browser input never chooses a host or command
 * @throws {Error} Invalid installation policy
 */
function configuration() {
    if (override) return override.config;
    const filename = process.env.UPTIME_KUMA_SITE_RECOVERY_CONFIG;
    if (!filename) return null;
    const folder = path.dirname(path.resolve(filename));
    protectedLocation([folder, filename]);
    const body = JSON.parse(privateFile(filename));
    if (
        Object.keys(body).sort().join(",") !== "brokers,targets,version" ||
        body.version !== 1 ||
        !Array.isArray(body.brokers) ||
        body.brokers.length < 1 ||
        body.brokers.length > 8 ||
        !Array.isArray(body.targets) ||
        body.targets.length > 32
    )
        throw problem("projectSiteRecoveryPolicy");
    const brokers = new Map();
    for (const broker of body.brokers) {
        if (
            Object.keys(broker).sort().join(",") !== "host,hostKeySHA256,id" ||
            !/^[a-z][a-z0-9-]{0,39}$/.test(broker.id) ||
            net.isIP(broker.host) !== 4 ||
            !/^[a-f0-9]{64}$/.test(broker.hostKeySHA256) ||
            brokers.has(broker.id)
        )
            throw problem("projectSiteRecoveryPolicy");
        brokers.set(broker.id, broker);
    }
    const ids = new Set();
    const monitors = new Set();
    const targets = body.targets.map((target) => {
        if (
            Object.keys(target).sort().join(",") !==
                "action,brokerID,checkURL,id,monitorID,ownerID,projectID,title,verifySeconds" ||
            !/^[a-z][a-z0-9-]{0,39}$/.test(target.id) ||
            !actions.includes(target.action) ||
            ![target.projectID, target.monitorID, target.ownerID].every(
                (value) => Number.isSafeInteger(value) && value > 0
            ) ||
            typeof target.title !== "string" ||
            !target.title.trim() ||
            target.title.length > 120 ||
            /[\u0000-\u001f]/.test(target.title) ||
            !brokers.has(target.brokerID) ||
            !Number.isInteger(target.verifySeconds) ||
            target.verifySeconds < 60 ||
            target.verifySeconds > 300 ||
            ids.has(target.projectID + ":" + target.id) ||
            monitors.has(target.projectID + ":" + target.monitorID)
        )
            throw problem("projectSiteRecoveryPolicy");
        const url = new URL(target.checkURL);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
            throw problem("projectSiteRecoveryPolicy");
        ids.add(target.projectID + ":" + target.id);
        monitors.add(target.projectID + ":" + target.monitorID);
        return {
            ...target,
            checkURL: url.href,
            fingerprint: digest(JSON.stringify({ ...target, broker: brokers.get(target.brokerID) })),
        };
    });
    const key = path.join(folder, "approval-private.pem");
    const identity = path.join(folder, "identity");
    protectedLocation([key, identity]);
    const signingKey = crypto.createPrivateKey(privateFile(key, 8192));
    if (signingKey.asymmetricKeyType !== "ed25519") throw problem("projectSiteRecoveryPolicy");
    return { targets, brokers, signingKey, identity: privateFile(identity, 16384) };
}

/**
 * @returns {object[]} Public descriptors without private transport configuration
 */
function profiles() {
    return configuration()?.targets || [];
}

/**
 * @param {object|null} value Isolated test-only dependency
 * @returns {void} Install a local test transport
 */
function setTestTransport(value) {
    override = value;
}

/**
 * @param {object} target Current fixed target
 * @param {string} operation Closed operation
 * @param {object} args Backend-approved job facts
 * @returns {Promise<object>} Bounded verified-host response; a lost mutation is never replayed here
 */
async function request(target, operation, args = {}) {
    const config = configuration();
    const current = config?.targets.find((item) => item.projectID === target.projectID && item.id === target.id);
    if (!current || current.fingerprint !== target.fingerprint || !operations.includes(operation))
        throw problem("projectSiteRecoveryPolicy");
    const code = Object.hasOwn(codeArguments, operation);
    const allowed = code
        ? [...codeArguments[operation]]
        : operation === "inspect"
          ? []
          : ["jobID", "planHash", "expectedHash", "policyHash", "approvedAt"];
    if (Object.keys(args).sort().join(",") !== allowed.sort().join(",")) throw problem("projectSiteRecoveryPolicy");
    if (override) return override.request(current, operation, args);
    const now = Date.now();
    const input = {
        version: 1,
        operation,
        targetID: current.id,
        projectID: current.projectID,
        monitorID: current.monitorID,
        ownerID: current.ownerID,
        issuedAt: now,
        expiresAt: now + 60000,
        nonce: crypto.randomBytes(16).toString("hex"),
        ...args,
    };
    if (
        input.operation !== operation ||
        input.targetID !== current.id ||
        input.projectID !== current.projectID ||
        input.monitorID !== current.monitorID ||
        input.ownerID !== current.ownerID
    )
        throw problem("projectSiteRecoveryPolicy");
    const payload = Buffer.from(JSON.stringify(input));
    if (payload.length > (code ? 196608 : 12288)) throw problem("projectSiteRecoveryPolicy");
    const envelope = JSON.stringify({
        version: 1,
        payload: payload.toString("base64url"),
        signature: crypto.sign(null, payload, config.signingKey).toString("base64url"),
    });
    const broker = config.brokers.get(current.brokerID);
    return new Promise((resolve, reject) => {
        const connection = new Client();
        let settled = false;
        let count = 0;
        let stderrCount = 0;
        const chunks = [];
        const timeout = setTimeout(
            () => finish(problem("projectSiteRecoveryUnavailable")),
            operation === "code_stage" || operation === "code_backup"
                ? 420000
                : code
                  ? 240000
                  : operation === "backup"
                    ? 180000
                    : 45000
        );
        /**
         * @param {Error|null} error Fixed transport failure
         * @param {object} value Bounded host receipt
         * @returns {void} Settle exactly once and close transport
         */
        function finish(error, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            connection.destroy();
            if (error) reject(error);
            else resolve(value);
        }
        connection.on("error", () => finish(problem("projectSiteRecoveryUnavailable")));
        connection.on("end", () => {
            if (!settled) finish(problem("projectSiteRecoveryUnavailable"));
        });
        connection.on("close", () => {
            if (!settled) finish(problem("projectSiteRecoveryUnavailable"));
        });
        connection.on("ready", () => {
            connection.exec("kuma-site-recovery-v1", { pty: false }, (error, stream) => {
                if (error) return finish(problem("projectSiteRecoveryUnavailable"));
                stream.on("data", (chunk) => {
                    count += chunk.length;
                    if (count > (code ? 393216 : 65536)) return finish(problem("projectSiteRecoveryPolicy"));
                    chunks.push(chunk);
                });
                stream.stderr.on("data", (chunk) => {
                    stderrCount += chunk.length;
                    if (stderrCount > 8192) finish(problem("projectSiteRecoveryPolicy"));
                });
                stream.on("error", () => finish(problem("projectSiteRecoveryUnavailable")));
                stream.on("close", (exitCode) => {
                    if (settled) return;
                    try {
                        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                        if (exitCode !== 0 || result?.ok !== true) {
                            const codes = {
                                conflict: "Conflict",
                                backup: "Backup",
                                blocked: "Blocked",
                                expired: "Stale",
                                maintenance: "Maintenance",
                                policy: "Policy",
                                unavailable: "Unavailable",
                            };
                            const codeErrors = {
                                not_configured: "NotConfigured",
                                sensitive: "Sensitive",
                                test: "TestFailed",
                                unsupported: "Unsupported",
                                space: "Space",
                                drift: "Drift",
                                policy: "Policy",
                                conflict: "Conflict",
                                maintenance: "Maintenance",
                                expired: "Stale",
                                unavailable: "Unavailable",
                                backup: "Backup",
                                blocked: "Blocked",
                            };
                            return finish(
                                problem(
                                    code
                                        ? "projectCodeRecovery" + (codeErrors[result?.code] || "Unavailable")
                                        : "projectSiteRecovery" + (codes[result?.code] || "Unavailable")
                                )
                            );
                        }
                        if (result.targetID !== current.id || (input.jobID && result.jobID !== input.jobID))
                            throw problem("projectSiteRecoveryPolicy");
                        finish(null, result);
                    } catch {
                        finish(problem("projectSiteRecoveryPolicy"));
                    }
                });
                stream.end(envelope);
            });
        });
        connection.connect({
            host: broker.host,
            port: 22,
            username: "kuma-site-recovery",
            privateKey: config.identity,
            hostHash: "sha256",
            hostVerifier: (hash) => typeof hash === "string" && hash === broker.hostKeySHA256,
            algorithms: { serverHostKey: ["ssh-ed25519"] },
            readyTimeout: 8000,
            keepaliveInterval: 3000,
            keepaliveCountMax: 3,
            tryKeyboard: false,
            agent: undefined,
        });
    });
}

module.exports = { profiles, request, digest, setTestTransport, actions };
