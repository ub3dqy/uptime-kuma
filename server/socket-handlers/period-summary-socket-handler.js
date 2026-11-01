const { checkLogin } = require("../util-server");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { validateExportRequest, MAX_EXPORT_ROWS } = require("../heartbeat-export");
const { buildPeriodSummary } = require("../period-summary");

const busyUsers = new Set();
const expectedErrors = new Set([
    "exportHistoryInvalidRange",
    "exportHistoryMonitorNotFound",
    "periodSummaryTooLarge",
    "periodSummaryBusy",
]);

/**
 * Register a bounded, authenticated summary endpoint. No messages, stored bodies
 * or monitor configuration are loaded into the summary.
 * @param {Socket} socket Socket.IO connection
 * @returns {void}
 */
module.exports.periodSummarySocketHandler = (socket) => {
    socket.on("getMonitorPeriodSummary", async (request, callback) => {
        if (typeof callback !== "function") {
            return;
        }
        const userID = socket.userID;
        let acquired = false;
        try {
            checkLogin(socket);
            const now = Date.now();
            const range = validateExportRequest(request, now);
            // Unlike the raw exporter, a time summary cannot include future time.
            if (Date.parse(request.end) > now) {
                throw new Error("exportHistoryInvalidRange");
            }
            if (busyUsers.has(userID)) {
                throw new Error("periodSummaryBusy");
            }
            busyUsers.add(userID);
            acquired = true;
            const monitor = await R.findOne("monitor", "id = ? AND user_id = ?", [range.monitorID, userID]);
            if (!monitor || monitor.type === "group") {
                throw new Error("exportHistoryMonitorNotFound");
            }
            const columns = "id, time, status, ping, check_interval, check_session";
            const rows = await R.getAll(
                `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time < ?
                 ORDER BY time ASC, id ASC LIMIT ${MAX_EXPORT_ROWS + 1}`,
                [range.monitorID, range.start, range.end]
            );
            if (rows.length > MAX_EXPORT_ROWS) {
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
            // Recheck the session after asynchronous work, including logout/relogin on this socket.
            checkLogin(socket);
            if (socket.userID !== userID) {
                throw new Error("periodSummaryFailed");
            }
            callback({
                ok: true,
                summary: buildPeriodSummary(
                    [...(before ? [before] : []), ...rows, ...(after ? [after] : [])],
                    request.start,
                    request.end
                ),
            });
        } catch (error) {
            if (userID && !expectedErrors.has(error.message)) {
                log.error("period-summary", error);
            }
            callback({
                ok: false,
                msg: expectedErrors.has(error.message) ? error.message : "periodSummaryFailed",
                msgi18n: true,
            });
        } finally {
            if (acquired) {
                busyUsers.delete(userID);
            }
        }
    });
};
