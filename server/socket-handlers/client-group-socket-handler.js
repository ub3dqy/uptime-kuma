const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const { listClientGroups, saveClientGroup, deleteClientGroup, buildClientReport } = require("../client-groups");

const busyUsers = new Set();
const expectedErrors = new Set([
    "clientGroupInvalid",
    "clientGroupNotFound",
    "clientGroupChanged",
    "clientGroupLimit",
    "clientGroupBusy",
    "periodSummaryTooLarge",
    "exportHistoryInvalidRange",
]);

/**
 * Register private client grouping and reporting. These groups grant no login access.
 * @param {Socket} socket Socket.IO connection
 * @returns {void}
 */
module.exports.clientGroupSocketHandler = (socket) => {
    const actions = {
        listClientGroups: async (userID) => ({ clients: await listClientGroups(userID) }),
        saveClientGroup: async (userID, request, guard) => ({ client: await saveClientGroup(userID, request, guard) }),
        deleteClientGroup: async (userID, request, guard) => {
            await deleteClientGroup(userID, request, guard);
            return {};
        },
        getClientReport: async (userID, request) => ({ report: await buildClientReport(userID, request) }),
    };
    for (const [event, action] of Object.entries(actions)) {
        socket.on(event, async (request, callback) => {
            if (typeof callback !== "function") {
                return;
            }
            const userID = socket.userID;
            let acquired = false;
            const guard = () => {
                checkLogin(socket);
                if (socket.userID !== userID) {
                    throw new Error("clientGroupFailed");
                }
            };
            try {
                guard();
                if (busyUsers.has(userID)) {
                    throw new Error("clientGroupBusy");
                }
                busyUsers.add(userID);
                acquired = true;
                const result = await action(userID, request, guard);
                guard();
                callback({ ok: true, ...result });
            } catch (error) {
                if (userID && !expectedErrors.has(error.message)) {
                    log.error("client-groups", error);
                }
                callback({
                    ok: false,
                    msg: expectedErrors.has(error.message) ? error.message : "clientGroupFailed",
                    msgi18n: true,
                });
            } finally {
                if (acquired) {
                    busyUsers.delete(userID);
                }
            }
        });
    }
};
