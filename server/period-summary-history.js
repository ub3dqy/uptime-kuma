const { R } = require("redbean-node");
const { MAX_EXPORT_ROWS } = require("./heartbeat-export");

/**
 * Read only bounded numeric history and its two clipping neighbors.
 * @param {object} range Validated monitor ID and SQL range
 * @param {number} now Captured upper observation timestamp
 * @param {number} budget Remaining in-period row budget
 * @returns {Promise<object>} Rows and in-period count
 * @throws {Error} History exceeds the request budget
 */
async function loadSummaryHistory(range, now, budget = MAX_EXPORT_ROWS) {
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_EXPORT_ROWS) {
        throw new Error("periodSummaryTooLarge");
    }
    const columns = "id, time, status, ping, check_interval, check_session";
    const rows = await R.getAll(
        `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time < ?
         ORDER BY time ASC, id ASC LIMIT ${budget + 1}`,
        [range.monitorID, range.start, range.end]
    );
    if (rows.length > budget) {
        throw new Error("periodSummaryTooLarge");
    }
    const before = await R.getRow(
        `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time < ? ORDER BY time DESC, id DESC LIMIT 1`,
        [range.monitorID, range.start]
    );
    const after = await R.getRow(
        `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time <= ?
         ORDER BY time ASC, id ASC LIMIT 1`,
        [range.monitorID, range.end, new Date(now).toISOString().replace("T", " ").replace("Z", "")]
    );
    return { rows: [...(before ? [before] : []), ...rows, ...(after ? [after] : [])], count: rows.length };
}

module.exports = { loadSummaryHistory };
