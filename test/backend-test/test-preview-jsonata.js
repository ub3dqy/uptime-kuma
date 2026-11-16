const assert = require("node:assert/strict");
const { test } = require("node:test");
const { evaluateJsonQuery } = require("../../src/util");
const { MqttMonitorType } = require("../../server/monitor-types/mqtt");
const { MongodbMonitorType } = require("../../server/monitor-types/mongodb");

test("the preview blocks expression checks for HTTP, MQTT and MongoDB", async (t) => {
    const previous = process.env.UPTIME_KUMA_DISABLE_JSONATA;
    process.env.UPTIME_KUMA_DISABLE_JSONATA = "1";
    t.after(() => {
        if (previous === undefined) {
            delete process.env.UPTIME_KUMA_DISABLE_JSONATA;
        } else {
            process.env.UPTIME_KUMA_DISABLE_JSONATA = previous;
        }
    });

    const error = { message: "JSONata expression checks are disabled in this build." };
    const mqtt = new MqttMonitorType();
    const mongodb = new MongodbMonitorType();
    t.mock.method(mongodb, "runMongodbCommand", async () => ({ ok: 1, value: 1 }));

    await assert.rejects(evaluateJsonQuery({ value: 1 }, "value", "==", "1"), error);
    await assert.rejects(evaluateJsonQuery(1, "", "==", "1"), error);
    await assert.rejects(mqtt.checkJsonQuery({ jsonPath: "value", expectedValue: "1" }, {}, '{"value":1}'), error);
    await assert.rejects(mqtt.checkConditions({ jsonPath: "value" }, {}, "sample", '{"value":1}', null), error);
    await assert.rejects(mongodb.check({ jsonPath: "value" }, {}), error);
});
