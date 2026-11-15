const http = require("node:http");

/**
 * Probe only the local app; a non-200 response must never be healthy.
 * @param {number} port Local port
 * @param {string} path Local health endpoint
 * @returns {Promise<void>} Successful bounded HTTP response
 */
function probe(port = 3001, path = "/api/entry-page") {
    return new Promise((resolve, reject) => {
        const request = http.get({ hostname: "127.0.0.1", port, path, timeout: 5000 }, (response) => {
            let bytes = 0;
            response.on("data", (data) => {
                bytes += data.length;
                if (bytes > 65536) {
                    request.destroy(new Error("Health response too large"));
                }
            });
            response.on("end", () =>
                response.statusCode === 200 ? resolve() : reject(new Error("Unexpected HTTP status"))
            );
            response.on("error", reject);
        });
        request.on("timeout", () => request.destroy(new Error("Health check timed out")));
        request.on("error", reject);
    });
}

if (require.main === module) {
    probe(Number(process.env.UPTIME_KUMA_PORT || 3001), process.env.UPTIME_KUMA_HEALTH_PATH || "/api/entry-page").catch(() => {
        process.exitCode = 1;
    });
}
module.exports = { probe };
