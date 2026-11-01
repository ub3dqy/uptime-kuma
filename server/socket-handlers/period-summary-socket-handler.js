const { checkLogin } = require("../util-server");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { validateExportRequest } = require("../heartbeat-export");
const { buildPeriodSummary } = require("../period-summary");
const { loadSummaryHistory } = require("../period-summary-history");

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
            const history = await loadSummaryHistory(range, now);
            // Recheck the session after asynchronous work, including logout/relogin on this socket.
            checkLogin(socket);
            if (socket.userID !== userID) {
                throw new Error("periodSummaryFailed");
            }
            callback({
                ok: true,
                summary: buildPeriodSummary(history.rows, request.start, request.end),
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
