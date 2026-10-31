const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");
const redis = require("redis");

class RedisMonitorType extends MonitorType {
    name = "redis";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        heartbeat.msg = await this.redisPingAsync(monitor.databaseConnectionString, !monitor.ignoreTls);
        heartbeat.status = UP;
    }

    /**
     * Redis server ping
     * @param {string} dsn The redis connection string
     * @param {boolean} rejectUnauthorized If false, allows unverified server certificates.
     * @returns {Promise<any>} Response from redis server
     */
    async redisPingAsync(dsn, rejectUnauthorized) {
        const client = redis.createClient({
            url: dsn,
            socket: { rejectUnauthorized, reconnectStrategy: false, connectTimeout: 5000 },
        });
        // The awaited connect/ping promises report errors to the monitor. Redis
        // also emits an error event, which must have a listener.
        client.on("error", () => {});
        try {
            await client.connect();
            return await client.ping();
        } finally {
            if (client.isOpen) {
                client.destroy();
            }
        }
    }
}

module.exports = {
    RedisMonitorType,
};
