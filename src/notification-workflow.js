const pending = new WeakMap();

/**
 * Serialize channel operations on an owner socket and discard replies across login changes.
 * @param {object} root Application root
 * @param {string} event Allowlisted workflow operation
 * @param {object} request Operation payload
 * @returns {Promise<object>} Authorized response
 */
export function workflowRequest(root, event, request = {}) {
    const socket = root.getSocket();
    const username = root.username;
    const token = root.socket.token;
    const current = () =>
        root.loggedIn && root.socket.connected && root.username === username && root.socket.token === token;
    const result = (pending.get(socket) || Promise.resolve())
        .catch(() => {})
        .then(
            () =>
                new Promise((resolve, reject) => {
                    if (!current()) {
                        reject(new Error("stage2DeliveryUnavailable"));
                        return;
                    }
                    socket.timeout(12000).emit(event, request, (error, response) => {
                        if (!current() || error || !response?.ok) {
                            reject(
                                new Error(
                                    !error && current()
                                        ? response?.msg || "stage2DeliveryUnavailable"
                                        : "stage2DeliveryUnavailable"
                                )
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
 * Human-facing delivery status; acceptance by a provider is not receipt by a person.
 * @param {object} job Delivery fact
 * @returns {string} Translation key
 */
export function deliveryLabel(job) {
    return job.confirmed_at
        ? "stage2DeliveryConfirmed"
        : {
              queued: "stage2DeliveryQueued",
              sending: "stage2DeliverySending",
              submitted: "stage2DeliverySubmitted",
              failed: "stage2DeliveryFailed",
              uncertain: "stage2DeliveryUncertain",
              cancelled: "stage2DeliveryCancelled",
          }[job.status] || "stage2DeliveryUncertain";
}
