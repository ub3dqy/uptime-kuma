const { checkLogin } = require("../util-server");
const {
    deliveryOverview,
    saveManagedChannel,
    deleteManagedChannel,
    requestTest,
    confirmReceipt,
} = require("../notification-delivery");
const busy = new Set();
const safeErrors = new Set([
    "stage2ProviderCooldown",
    "stage2InvalidRequest",
    "stage2ChannelInvalid",
    "stage2ChannelChanged",
    "stage2ChannelNotFound",
    "stage2QueueFull",
    "stage2TestCooldown",
    "stage2ConfirmationInvalid",
    "criticalAlertChannels",
    "browserJourneyInvalid",
    "browserJourneyLocalOnly",
    "verificationUnavailable",
]);
/**
 * @param {unknown} message Error category
 * @returns {boolean} Safe for either the owner or project workflow
 */
module.exports.isSafeDeliveryError = (message) => safeErrors.has(message);

/**
 * Owner-checked setup and delivery facts. No request accepts arbitrary message text or URLs.
 * @param {Socket} socket Authenticated socket
 * @param {Function} sendNotificationList Existing owner update
 * @returns {void}
 */
module.exports.deliverySocketHandler = (socket, sendNotificationList) => {
    const actions = {
        getNotificationDelivery: (userID, request) => deliveryOverview(userID, request?.monitorID ?? null),
        saveManagedNotification: async (userID, request, guard) => {
            const id = await saveManagedChannel(userID, request, guard);
            guard();
            await sendNotificationList(socket);
            return { id };
        },
        testSavedNotification: async (userID, request, guard) => ({ id: await requestTest(userID, request, guard) }),
        deleteManagedNotification: async (userID, request, guard) => {
            await deleteManagedChannel(userID, request, guard);
            guard();
            await sendNotificationList(socket);
            return {};
        },
        confirmNotificationReceipt: async (userID, request, guard) => {
            await confirmReceipt(userID, request?.id, guard);
            return {};
        },
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
                    throw new Error("stage2DeliveryUnavailable");
                }
            };
            try {
                guard();
                if (busy.has(userID)) {
                    throw new Error("stage2DeliveryUnavailable");
                }
                busy.add(userID);
                acquired = true;
                const result = await action(userID, request, guard);
                guard();
                callback({ ok: true, ...result });
            } catch (error) {
                callback({
                    ok: false,
                    msg: safeErrors.has(error.message) ? error.message : "stage2DeliveryUnavailable",
                    msgi18n: true,
                });
            } finally {
                if (acquired) {
                    busy.delete(userID);
                }
            }
        });
    }
};
