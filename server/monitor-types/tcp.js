const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");
const tcpp = require("tcp-ping");
const net = require("node:net");

/**
 * Send TCP request to specified hostname and port
 * @param {string} hostname Hostname / address of machine
 * @param {number} port TCP port to test
 * @returns {Promise<number>} Maximum time in ms rounded to nearest integer
 */
const tcping = (hostname, port) => {
    return new Promise((resolve, reject) => {
        tcpp.ping(
            {
                address: hostname,
                port: port,
                attempts: 1,
            },
            (err, data) => {
                if (err) {
                    reject(err);
                }

                if (data.results.length >= 1 && data.results[0].err) {
                    reject(data.results[0].err);
                }

                resolve(Math.round(data.max));
            }
        );
    });
};

class TCPMonitorType extends MonitorType {
    name = "port";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        try {
            const policy = await require("../projects/network-policy").policyForOwner(monitor.user_id);
            if (policy) {
                const [address] = await policy.addresses(monitor.hostname);
                const started = Date.now();
                await new Promise((resolve, reject) => {
                    const socket = net.createConnection({ host: address, port: monitor.port });
                    socket.setTimeout(15000, () => socket.destroy(new Error("Connection timeout")));
                    socket.once("connect", () => {
                        socket.destroy();
                        resolve();
                    });
                    socket.once("error", reject);
                });
                heartbeat.ping = Date.now() - started;
                heartbeat.msg = `${heartbeat.ping} ms`;
                heartbeat.status = UP;
                return;
            }
            const resp = await tcping(monitor.hostname, monitor.port);
            heartbeat.ping = resp;
            heartbeat.msg = `${resp} ms`;
            heartbeat.status = UP;
        } catch {
            throw new Error("Connection failed");
        }
    }
}

module.exports = {
    TCPMonitorType,
};
