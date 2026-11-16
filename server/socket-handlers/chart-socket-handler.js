const { checkLogin } = require("../util-server");
const { UptimeCalculator } = require("../uptime-calculator");
const { R } = require("redbean-node");
const { log } = require("../../src/util");

const periods = new Set([3, 6, 24, 168]);

module.exports.chartSocketHandler = (socket) => {
    socket.on("getMonitorChartData", async (monitorID, period, callback) => {
        if (typeof callback !== "function") return;
        const userID = socket.userID;
        const generation = socket.projectGeneration;
        try {
            checkLogin(socket);

            // The previous dashboard sends the stored selection as a string.
            const hours = typeof period === "string" && /^(3|6|24|168)$/.test(period) ? Number(period) : period;
            if (!Number.isSafeInteger(monitorID) || monitorID < 1 || !periods.has(hours)) {
                return callback({ ok: false, msg: "Invalid chart request." });
            }

            const monitor = await R.findOne("monitor", "id = ? AND user_id = ?", [monitorID, userID]);
            const sameSession = () =>
                socket.userID === userID && socket.projectGeneration === generation && !socket.disconnected;
            if (!monitor || monitor.type === "group" || !sameSession()) {
                return callback({ ok: false, msg: "Monitor not found." });
            }
            const calculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            if (!sameSession()) {
                return callback({ ok: false, msg: "Monitor not found." });
            }
            const data =
                hours <= 24 ? calculator.getDataArray(hours * 60, "minute") : calculator.getDataArray(hours, "hour");
            callback({ ok: true, data });
        } catch (e) {
            if (userID) log.error("monitor-chart", e);
            callback({ ok: false, msg: "Could not load chart data." });
        }
    });
};
