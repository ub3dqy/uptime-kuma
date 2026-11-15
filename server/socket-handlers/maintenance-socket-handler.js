const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const Maintenance = require("../model/maintenance");
const server = UptimeKumaServer.getInstance();

/**
 * @param {object} db Current database connection or transaction
 * @param {number} maintenanceID Requested window
 * @param {number} userID Logged-in owner
 * @returns {Promise<void>} Require ownership before reading or changing associations
 */
async function requireOwner(db, maintenanceID, userID) {
    const query = db("maintenance").where({ id: maintenanceID, user_id: userID }).first("id");
    if (db.isTransaction) {
        query.forUpdate();
    }
    if (!(await query)) {
        throw new Error("Maintenance not found");
    }
}

/**
 * Handlers for Maintenance
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.maintenanceSocketHandler = (socket) => {
    // Add a new maintenance
    socket.on("addMaintenance", async (maintenance, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", maintenance);

            let bean = await Maintenance.jsonToBean(R.dispense("maintenance"), maintenance);
            bean.user_id = socket.userID;
            let maintenanceID = await R.store(bean);

            server.maintenanceList[maintenanceID] = bean;
            await bean.run(true);

            await server.sendMaintenanceList(socket);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                maintenanceID,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Edit a maintenance
    socket.on("editMaintenance", async (maintenance, callback) => {
        try {
            checkLogin(socket);

            let bean = server.getMaintenance(maintenance.id);

            if (!bean || bean.user_id !== socket.userID) {
                throw new Error("Permission denied.");
            }

            await Maintenance.jsonToBean(bean, maintenance);
            await R.store(bean);
            await bean.run(true);
            await server.sendMaintenanceList(socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                maintenanceID: bean.id,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Add a new monitor_maintenance
    socket.on("addMonitorMaintenance", async (maintenanceID, monitors, callback) => {
        try {
            checkLogin(socket);

            const userID = socket.userID;
            await R.knex.transaction(async (tx) => {
                await requireOwner(tx, maintenanceID, userID);
                const ids = [...new Set(monitors.map((monitor) => monitor.id))];
                const owned = await tx("monitor").where("user_id", userID).whereIn("id", ids).select("id");
                if (owned.length !== ids.length) {
                    throw new Error("Monitor not found");
                }
                await tx("monitor_maintenance").where({ maintenance_id: maintenanceID }).delete();
                if (owned.length) {
                    await tx("monitor_maintenance").insert(owned.map(({ id }) => ({
                        monitor_id: id,
                        maintenance_id: maintenanceID,
                    })));
                }
            });

            apicache.clear();

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Add a new monitor_maintenance
    socket.on("addMaintenanceStatusPage", async (maintenanceID, statusPages, callback) => {
        try {
            checkLogin(socket);

            const userID = socket.userID;
            await R.knex.transaction(async (tx) => {
                await requireOwner(tx, maintenanceID, userID);
                await tx("maintenance_status_page").where({ maintenance_id: maintenanceID }).delete();
                if (statusPages.length) {
                    await tx("maintenance_status_page").insert(statusPages.map(({ id }) => ({
                        status_page_id: id,
                        maintenance_id: maintenanceID,
                    })));
                }
            });

            apicache.clear();

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Get Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let bean = await R.findOne("maintenance", " id = ? AND user_id = ? ", [maintenanceID, socket.userID]);

            callback({
                ok: true,
                maintenance: await bean.toJSON(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenanceList", async (callback) => {
        try {
            checkLogin(socket);
            await server.sendMaintenanceList(socket);
            callback({
                ok: true,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMonitorMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            await requireOwner(R.knex, maintenanceID, socket.userID);

            log.debug("maintenance", `Get Monitors for Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let monitors = await R.knex("monitor_maintenance as mm")
                .join("monitor", "mm.monitor_id", "monitor.id")
                .where({ "mm.maintenance_id": maintenanceID, "monitor.user_id": socket.userID })
                .select("monitor.id");

            callback({
                ok: true,
                monitors,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenanceStatusPage", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);
            await requireOwner(R.knex, maintenanceID, socket.userID);

            log.debug("maintenance", `Get Status Pages for Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let statusPages = await R.getAll(
                "SELECT status_page.id, status_page.title FROM maintenance_status_page msp JOIN status_page ON msp.status_page_id = status_page.id WHERE msp.maintenance_id = ? ",
                [maintenanceID]
            );

            callback({
                ok: true,
                statusPages,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Delete Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            const removed = await R.knex("maintenance").where({ id: maintenanceID, user_id: socket.userID }).delete();
            if (!removed) {
                throw new Error("Maintenance not found");
            }
            server.maintenanceList[maintenanceID]?.stop();
            delete server.maintenanceList[maintenanceID];

            apicache.clear();

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });

            await server.sendMaintenanceList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("pauseMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Pause Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let maintenance = server.getMaintenance(maintenanceID);

            if (!maintenance || maintenance.user_id !== socket.userID) {
                throw new Error("Maintenance not found");
            }

            maintenance.active = false;
            await R.store(maintenance);
            maintenance.stop();

            apicache.clear();

            callback({
                ok: true,
                msg: "successPaused",
                msgi18n: true,
            });

            await server.sendMaintenanceList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("resumeMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Resume Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let maintenance = server.getMaintenance(maintenanceID);

            if (!maintenance || maintenance.user_id !== socket.userID) {
                throw new Error("Maintenance not found");
            }

            maintenance.active = true;
            await R.store(maintenance);
            await maintenance.run();

            apicache.clear();

            callback({
                ok: true,
                msg: "successResumed",
                msgi18n: true,
            });

            await server.sendMaintenanceList(socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
