const pending = new WeakMap();

/**
 * Project requests stay attached to the current human login and never use a data-owner login.
 * @param {object} root Application
 * @param {string} event Closed operation
 * @param {object} request Payload
 * @param {boolean} publicAction Invitation lookup/redeem
 * @returns {Promise<object>} Current authorized reply
 */
export function projectRequest(root, event, request = {}, publicAction = false) {
    const socket = root.getSocket();
    const token = root.socket.token;
    const username = root.username;
    const current = () =>
        root.socket.connected &&
        root.socket.token === token &&
        root.username === username &&
        (publicAction || root.loggedIn);
    const result = (pending.get(socket) || Promise.resolve())
        .catch(() => {})
        .then(
            () =>
                new Promise((resolve, reject) => {
                    if (!current()) {
                        reject(new Error("projectAccessDenied"));
                        return;
                    }
                    socket.timeout(60000).emit(event, request, (error, response) => {
                        if (!current()) {
                            reject(new Error("projectAccessDenied"));
                        } else if (error || !response?.ok) {
                            reject(
                                new Error(error ? "projectOperationFailed" : response?.msg || "projectOperationFailed")
                            );
                        } else {
                            resolve(response);
                        }
                    });
                })
        );
    pending.set(
        socket,
        result.catch(() => {})
    );
    return result;
}

/**
 * @param {object} root App
 * @param {number} projectID Scope
 * @returns {Function} Adapter for the existing guided channel workflow
 */
export function projectChannelRequest(root, projectID) {
    const events = {
        getNotificationDelivery: "projectDeliveryGet",
        getAlertRules: "projectAlertRules",
        saveAlertRule: "projectSaveAlertRule",
        saveManagedNotification: "projectDeliverySave",
        testSavedNotification: "projectDeliveryTest",
        confirmNotificationReceipt: "projectDeliveryConfirm",
        deleteManagedNotification: "projectDeliveryDelete",
    };
    return (event, request = {}) => {
        if (!events[event]) {
            return Promise.reject(new Error("projectInvalid"));
        }
        return projectRequest(root, events[event], { ...request, projectID });
    };
}
