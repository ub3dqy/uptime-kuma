const { checkLogin } = require("../util-server");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { validateExportRequest, buildHeartbeatCsv, MAX_EXPORT_ROWS, MAX_EXPORT_BYTES } = require("../heartbeat-export");

const busyUsers = new Set();
const expectedErrors = new Set([
    "exportHistoryInvalidRange",
    "exportHistoryTooLarge",
    "exportHistoryMonitorNotFound",
    "exportHistoryBusy",
]);

/**
 * Register authenticated, owner-scoped history export.
 * @param {Socket} socket Socket.IO connection
 * @returns {void}
 */
module.exports.heartbeatExportSocketHandler = (socket) => {
    socket.on("exportMonitorHistory", async (request, callback) => {
        if (typeof callback !== "function") {
            return;
        }
        let acquired = false;
        const userID = socket.userID;
        try {
            checkLogin(socket);
            const range = validateExportRequest(request);
            if (busyUsers.has(userID)) {
                throw new Error("exportHistoryBusy");
            }
            busyUsers.add(userID);
            acquired = true;
            const monitor = await R.findOne("monitor", "id = ? AND user_id = ?", [range.monitorID, userID]);
            if (!monitor) {
                throw new Error("exportHistoryMonitorNotFound");
            }
            const parameters = [range.monitorID, range.start, range.end];
            const size = await R.getRow(
                `SELECT COUNT(*) AS row_count, SUM(LENGTH(COALESCE(msg, ''))) AS message_chars
                 FROM (SELECT msg FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time < ?
                       LIMIT ${MAX_EXPORT_ROWS + 1}) AS export_rows`,
                parameters
            );
            if (size.row_count > MAX_EXPORT_ROWS || size.message_chars > MAX_EXPORT_BYTES) {
                throw new Error("exportHistoryTooLarge");
            }
            const beats = await R.getAll(
                `SELECT time, status, ping, duration, msg FROM heartbeat
                 WHERE monitor_id = ? AND time >= ? AND time < ?
                 ORDER BY time ASC, id ASC LIMIT ${MAX_EXPORT_ROWS + 1}`,
                parameters
            );
            callback({
                ok: true,
                csv: buildHeartbeatCsv(monitor, beats),
                rowCount: beats.length,
                filename: `monitor-${monitor.id}-${request.start.slice(0, 10)}-${request.end.slice(0, 10)}.csv`,
            });
        } catch (error) {
            if (userID && !expectedErrors.has(error.message)) {
                log.error("heartbeat-export", error);
            }
            callback({
                ok: false,
                msg: expectedErrors.has(error.message) ? error.message : "exportHistoryFailed",
                msgi18n: true,
            });
        } finally {
            if (acquired) {
                busyUsers.delete(userID);
            }
        }
    });
};
