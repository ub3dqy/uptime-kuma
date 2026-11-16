const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { protectedLocation } = require("./vault");
const { problem } = require("./access");
const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const maximum = 32768;
let cachedManifest;

/**
 * @param {string} filename Exact candidate configuration
 * @param {string} manifest Current installer policy
 * @returns {void} The application cannot repair its own credentials, source or database
 * @throws {Error} A protected installation asset was selected
 */
function protectInstallation(filename, manifest) {
    const Database = require("../database");
    const projectRoot = path.resolve(__dirname, "../..");
    const dataRoot = path.resolve(Database.dataDir || "data");
    const keyFile = path.resolve(
        process.env.UPTIME_KUMA_PROJECT_KEY_FILE || path.join(dataRoot, "project-secrets/keys.json")
    );
    const exact = [
        manifest,
        keyFile,
        path.join(dataRoot, "kuma.db"),
        path.join(dataRoot, "db-config.json"),
        path.resolve(process.env.UPTIME_KUMA_WITNESS_CONFIG || path.join(dataRoot, "witness/config.json")),
        path.resolve(process.env.UPTIME_KUMA_AI_WORKER_CONFIG || path.join(dataRoot, "ai-worker/config.json")),
        path.join(projectRoot, "package.json"),
        path.join(projectRoot, "package-lock.json"),
    ];
    const roots = [
        path.dirname(keyFile),
        path.join(dataRoot, "witness"),
        path.join(dataRoot, "ai-worker"),
        ...["server", "src", "db", "config", "node_modules", ".git", "dist"].map((part) =>
            path.join(projectRoot, part)
        ),
    ];
    const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    const current = normalize(filename);
    if (
        exact.some((value) => normalize(value) === current) ||
        roots.some((root) => current === normalize(root) || current.startsWith(normalize(root) + path.sep))
    ) {
        throw problem("projectRecoveryPolicy");
    }
}

/**
 * No component may redirect a trusted application path through a link or junction.
 * @param {string} filename Absolute configured path
 * @returns {string} Checked absolute path
 * @throws {Error} Unsafe or unavailable path
 */
function noLinks(filename) {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || /[\u0000-\u001f]/.test(filename)) {
        throw problem("projectRecoveryPolicy");
    }
    const resolved = path.resolve(filename);
    let current = path.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) {
            throw problem("projectRecoveryPolicy");
        }
    }
    return resolved;
}

/**
 * @param {string} root Dedicated application directory
 * @param {string} filename Exact existing child file
 * @returns {string} Confined path
 * @throws {Error} Path is outside the approved application or writable by others
 */
function confined(root, filename) {
    const base = noLinks(root);
    const result = noLinks(filename);
    const relative = path.relative(base, result);
    if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
        throw problem("projectRecoveryPolicy");
    }
    if (!fs.statSync(base).isDirectory() || base === path.parse(base).root) {
        throw problem("projectRecoveryPolicy");
    }
    let parent = path.dirname(result);
    for (;;) {
        if (process.platform !== "win32" && fs.statSync(parent).mode & 0o022) {
            throw problem("projectRecoveryPolicy");
        }
        if (parent === base) {
            break;
        }
        parent = path.dirname(parent);
    }
    return result;
}

/**
 * @param {string} filename Configured regular file
 * @param {number} limit Maximum bytes
 * @returns {object} Exact bytes and identity
 * @throws {Error} Unsafe, oversized or unavailable file
 */
function readFile(filename, limit = maximum) {
    noLinks(filename);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const stat = fs.fstatSync(fd);
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size > limit ||
            (process.platform !== "win32" && stat.mode & 0o022)
        ) {
            throw problem("projectRecoveryPolicy");
        }
        const buffer = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
            if (!count) {
                break;
            }
            length += count;
        }
        const bytes = Buffer.from(buffer.subarray(0, length));
        if (bytes.length > limit) {
            throw problem("projectRecoveryPolicy");
        }
        return {
            bytes,
            hash: digest(bytes),
            mode: stat.mode & 0o777,
            uid: stat.uid,
            gid: stat.gid,
            ino: stat.ino,
            dev: stat.dev,
        };
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Load only an installation owner's closed manifest. Browser/model data never supplies paths or commands.
 * @returns {object[]} Validated fixed recipes
 * @throws {Error} The installation manifest or its targets are unsafe
 */
function profiles() {
    const filename = process.env.UPTIME_KUMA_RECOVERY_MANIFEST;
    if (!filename) {
        return [];
    }
    const source = noLinks(filename);
    const sourceStat = fs.statSync(source);
    const raw = readFile(source, 65536).bytes.toString("utf8");
    const signature = [
        source,
        sourceStat.ino,
        sourceStat.size,
        sourceStat.mtimeMs,
        sourceStat.ctimeMs,
        digest(raw),
    ].join(":");
    if (cachedManifest?.signature === signature) {
        return cachedManifest.targets;
    }
    protectedLocation([path.dirname(source), source]);
    if (fs.statSync(source).size > 65536) {
        throw problem("projectRecoveryPolicy");
    }
    const body = JSON.parse(raw);
    if (body.version !== 1 || !Array.isArray(body.targets) || body.targets.length > 32) {
        throw problem("projectRecoveryPolicy");
    }
    const ids = new Set();
    const fileNames = new Set();
    const locations = [path.dirname(source), source];
    const targets = body.targets.map((target) => {
        if (
            !target ||
            !/^[a-z][a-z0-9-]{0,39}$/.test(target.id) ||
            !Number.isSafeInteger(target.projectID) ||
            target.projectID < 1 ||
            !Number.isSafeInteger(target.monitorID) ||
            target.monitorID < 1 ||
            typeof target.title !== "string" ||
            !target.title.trim() ||
            target.title.length > 120 ||
            /[\u0000-\u001f]/.test(target.title) ||
            typeof target.checkURL !== "string" ||
            !/^[a-f0-9]{64}$/.test(target.baselineSha256) ||
            !["live", "systemd"].includes(target.reload?.kind) ||
            !Number.isInteger(target.verifySeconds) ||
            target.verifySeconds < 60 ||
            target.verifySeconds > 180 ||
            ids.has(target.projectID + ":" + target.id)
        ) {
            throw problem("projectRecoveryPolicy");
        }
        ids.add(target.projectID + ":" + target.id);
        const url = new URL(target.checkURL);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
            throw problem("projectRecoveryPolicy");
        }
        const root = noLinks(target.root);
        const file = confined(root, target.file);
        if (path.extname(file).toLowerCase() !== ".json") {
            throw problem("projectRecoveryPolicy");
        }
        protectInstallation(file, source);
        const baseline = confined(root, target.baseline);
        const uniqueFile = process.platform === "win32" ? file.toLowerCase() : file;
        if (file === baseline || fileNames.has(uniqueFile)) {
            throw problem("projectRecoveryPolicy");
        }
        fileNames.add(uniqueFile);
        if (process.platform === "win32") {
            locations.push(root, path.dirname(file), file, path.dirname(baseline), baseline);
        }
        const reload = { kind: target.reload.kind };
        if (reload.kind === "systemd") {
            const unit = `kuma-managed-p${target.projectID}-${target.id}.service`;
            if (
                process.platform !== "linux" ||
                process.env.UPTIME_KUMA_RECOVERY_SYSTEMD !== "1" ||
                target.reload.unit !== unit
            ) {
                throw problem("projectRecoveryPolicy");
            }
            reload.unit = unit;
        }
        const result = {
            id: target.id,
            projectID: target.projectID,
            monitorID: target.monitorID,
            title: target.title.trim(),
            root,
            file,
            baseline,
            baselineSha256: target.baselineSha256,
            checkURL: url.href,
            reload,
            verifySeconds: target.verifySeconds,
        };
        return { ...result, fingerprint: digest(JSON.stringify(result)) };
    });
    if (process.platform === "win32") {
        protectedLocation([...new Set(locations)]);
    }
    cachedManifest = { signature, targets };
    return targets;
}

/**
 * @param {object} target Trusted recipe
 * @returns {object} Current and approved baseline, never public contents
 * @throws {Error} The approved baseline or current file is invalid
 */
function inspect(target) {
    confined(target.root, target.file);
    confined(target.root, target.baseline);
    if (process.platform === "win32") {
        protectedLocation([
            target.root,
            path.dirname(target.file),
            target.file,
            path.dirname(target.baseline),
            target.baseline,
        ]);
    }
    const before = readFile(target.file);
    const baseline = readFile(target.baseline);
    let json;
    try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(baseline.bytes));
    } catch {
        throw problem("projectRecoveryBaseline");
    }
    if (!json || typeof json !== "object" || Array.isArray(json) || baseline.hash !== target.baselineSha256) {
        throw problem("projectRecoveryBaseline");
    }
    if (before.hash === baseline.hash) {
        throw problem("projectRecoveryNoChange");
    }
    return { before, baseline };
}

/**
 * Atomically replace one approved file, preserving its access rights. Snapshot is durable first.
 * @param {object} target Trusted descriptor
 * @param {string} expected Exact current digest
 * @param {Buffer} bytes Authorized replacement
 * @param {object} metadata Original file permissions
 * @param {Function} guard Final current authorization and cancellation check
 * @returns {Promise<void>} One replacement
 */
async function replace(target, expected, bytes, metadata, guard) {
    confined(target.root, target.file);
    const current = readFile(target.file);
    if (
        current.hash !== expected ||
        current.mode !== metadata.mode ||
        current.uid !== metadata.uid ||
        current.gid !== metadata.gid
    ) {
        throw problem("projectRecoveryDrift");
    }
    const temporary = path.join(path.dirname(target.file), ".kuma-recovery-" + randomBytes(12).toString("hex"));
    let renamed = false;
    try {
        const fd = fs.openSync(temporary, "wx", metadata.mode);
        try {
            fs.writeFileSync(fd, bytes);
            if (process.platform !== "win32") {
                fs.fchownSync(fd, metadata.uid, metadata.gid);
                fs.fchmodSync(fd, metadata.mode);
            }
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (process.platform === "win32") {
            const env = { ...process.env, KUMA_RECOVERY_SOURCE: target.file, KUMA_RECOVERY_TEMP: temporary };
            delete env.PSModulePath;
            await execute(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:KUMA_RECOVERY_SOURCE; Set-Acl -LiteralPath $env:KUMA_RECOVERY_TEMP -AclObject $acl",
                ],
                { env, timeout: 20000, maxBuffer: 1024, windowsHide: true }
            );
        }
        await guard();
        confined(target.root, target.file);
        const latest = readFile(target.file);
        if (latest.hash !== expected || latest.ino !== current.ino || latest.dev !== current.dev) {
            throw problem("projectRecoveryDrift");
        }
        fs.renameSync(temporary, target.file);
        renamed = true;
        if (process.platform !== "win32") {
            const directory = fs.openSync(path.dirname(target.file), "r");
            try {
                fs.fsyncSync(directory);
            } finally {
                fs.closeSync(directory);
            }
        }
        if (readFile(target.file).hash !== digest(bytes)) {
            throw problem("projectRecoveryDrift");
        }
    } finally {
        // Only this operation's exact random temporary file may be removed.
        if (!renamed && fs.existsSync(temporary)) {
            fs.unlinkSync(temporary);
        }
    }
}

/**
 * @param {object} target Fixed systemd or live-reading recipe
 * @param {string} action Read, apply or return prior running state
 * @param {string} previous Prior running/non-running state
 * @returns {Promise<string>} Actual service state
 */
async function service(target, action = "read", previous = "active") {
    if (target.reload.kind === "live") {
        return "live";
    }
    const options = {
        timeout: 15000,
        maxBuffer: 1024,
        windowsHide: true,
        env: { ...process.env, SYSTEMD_PAGER: "cat", SYSTEMD_COLORS: "0" },
    };
    const command = "/usr/bin/systemctl";
    if (action !== "read") {
        await execute(
            command,
            [
                "--no-ask-password",
                action === "rollback" && previous !== "active" ? "stop" : "restart",
                "--",
                target.reload.unit,
            ],
            options
        );
    }
    const { stdout } = await execute(
        command,
        ["--no-ask-password", "show", "--property=ActiveState", "--value", "--", target.reload.unit],
        options
    );
    const state = stdout.trim();
    if (!["active", "inactive", "failed"].includes(state)) {
        throw problem("projectRecoveryService");
    }
    return state;
}

module.exports = { profiles, inspect, readFile, replace, service, digest, noLinks, confined };
