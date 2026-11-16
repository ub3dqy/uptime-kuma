const fs = require("node:fs");
const path = require("node:path");
const SQLite = require("better-sqlite3");
const { buildPeriodSummary } = require("../server/period-summary");
const { validateExportRequest, MAX_EXPORT_ROWS } = require("../server/heartbeat-export");

/**
 * Produce private daily evidence for only the sealed synthetic pilot monitors.
 * @param {string} directory Owned app data directory
 * @param {string} start Inclusive UTC time
 * @param {string} end Exclusive UTC time
 * @returns {object} Numeric summaries, with no messages, bodies or credentials
 * @throws {Error} Invalid scope, time or excessive retained history
 */
function dailyReport(directory, start, end) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "pilot-monitors.json"), "utf8"));
    if (
        !Number.isSafeInteger(manifest.userID) ||
        !Array.isArray(manifest.monitorIDs) ||
        manifest.monitorIDs.length < 1 ||
        manifest.monitorIDs.length > 10 ||
        manifest.monitorIDs.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(manifest.monitorIDs).size !== manifest.monitorIDs.length
    ) {
        throw new Error("Invalid pilot monitor scope");
    }
    const now = Date.now();
    const range = validateExportRequest({ monitorID: manifest.monitorIDs[0], start, end }, now);
    if (Date.parse(end) > now) {
        throw new Error("Future pilot period");
    }
    const db = new SQLite(path.join(directory, "kuma.db"), { readonly: true, fileMustExist: true });
    try {
        db.pragma("query_only = ON");
        let budget = MAX_EXPORT_ROWS;
        const monitors = [];
        const columns = "time, status, ping, check_interval, check_session";
        for (const id of manifest.monitorIDs) {
            const monitor = db
                .prepare("SELECT id, name FROM monitor WHERE id = ? AND user_id = ?")
                .get(id, manifest.userID);
            if (!monitor || !monitor.name.startsWith("Pilot/")) {
                throw new Error("Pilot monitor was changed");
            }
            const rows = db
                .prepare(
                    `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time < ? ORDER BY time, id LIMIT ?`
                )
                .all(id, range.start, range.end, budget + 1);
            if (rows.length > budget) {
                throw new Error("periodSummaryTooLarge");
            }
            budget -= rows.length;
            const before = db
                .prepare(
                    `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time < ? ORDER BY time DESC, id DESC LIMIT 1`
                )
                .get(id, range.start);
            const after = db
                .prepare(
                    `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time <= ? ORDER BY time, id LIMIT 1`
                )
                .get(id, range.end, new Date(now).toISOString().replace("T", " ").replace("Z", ""));
            monitors.push({
                ...monitor,
                summary: buildPeriodSummary(
                    [...(before ? [before] : []), ...rows, ...(after ? [after] : [])],
                    start,
                    end
                ),
            });
        }
        return { synthetic: true, generatedAt: new Date(now).toISOString(), start, end, monitors };
    } finally {
        db.close();
    }
}

if (require.main === module) {
    try {
        process.stdout.write(JSON.stringify(dailyReport("/app/data", process.argv[2], process.argv[3])));
    } catch {
        process.stderr.write("Pilot daily report failed\n");
        process.exitCode = 1;
    }
}
module.exports = { dailyReport };
