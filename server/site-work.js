const fs = require("node:fs");
const path = require("node:path");
const { serviceHost } = require("../src/overview-state.ts");
const { validatedWork } = require("../src/site-work.ts");
const maxAge = 45000;

/**
 * Read only a local administrator-installed observer. Nothing supplied by a
 * monitored HTTP response can create maintenance or suppress its alerts.
 * @param {string} filename Protected local observation file
 * @returns {Promise<object|null>} Small trusted envelope, or no signal
 */
async function readSignals(filename) {
    let handle;
    try {
        if ((await fs.promises.lstat(filename)).isSymbolicLink()) return null;
        handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const info = await handle.stat();
        if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.size > 65536 ||
            (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        )
            return null;
        if (process.geteuid && info.uid !== process.geteuid()) return null;
        const value = JSON.parse(await handle.readFile("utf8"));
        if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > 200) return null;
        return value;
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => {});
    }
}

/**
 * A stale, malformed, mismatched or expired signal never disables monitoring.
 * The absolute deadline comes from the original server flag, not a polling time.
 * @param {object} monitor Current owned check (with full URL or safe hostname)
 * @param {number} now Current UTC milliseconds
 * @param {string|null} filename Isolated verification override
 * @returns {Promise<object|null>} Fresh active/idle/overdue signal
 */
async function signalForMonitor(monitor, now = Date.now(), filename = null) {
    if (!filename) {
        const directory = require("./database").dataDir;
        if (!directory) return null;
        filename = path.join(directory, "site-work.json");
    }
    const envelope = await readSignals(filename);
    if (!envelope) return null;
    const matches = envelope.records.filter((record) => record?.monitorID === monitor.id);
    if (matches.length !== 1) return null;
    const row = matches[0];
    if (
        row.ownerID !== monitor.user_id ||
        row.host !== serviceHost(monitor) ||
        !Number.isSafeInteger(row.observedAt) ||
        row.observedAt > now + 5000 ||
        now - row.observedAt > maxAge
    )
        return null;
    if (row.state === "idle") return { state: "idle", observedAt: row.observedAt };
    const work = validatedWork(row.work);
    if (row.state !== "active" || !work || work.startedAt > now + 5000 || work.startedAt > row.observedAt) return null;
    return { state: now < work.deadline ? "active" : "overdue", observedAt: row.observedAt, work };
}

module.exports = { signalForMonitor, readSignals };
