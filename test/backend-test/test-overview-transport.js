const { test } = require("node:test");
const assert = require("node:assert/strict");
const Heartbeat = require("../../server/model/heartbeat");

test("owner observations preserve continuity evidence without publishing it publicly", async () => {
    const beat = Object.assign(Object.create(Heartbeat.prototype), {
        _status: 1,
        _time: "2026-11-01 12:00:00.000",
        _ping: 0,
        _checkInterval: 60,
        _checkSession: "recorded-run",
    });
    for (const payload of [beat.toJSON(), await beat.toJSONAsync()]) {
        assert.equal(payload.check_interval, 60);
        assert.equal(payload.check_session, "recorded-run");
        assert.equal(payload.ping, 0);
    }
    const publicPayload = beat.toPublicJSON();
    assert.equal(Object.hasOwn(publicPayload, "check_interval"), false);
    assert.equal(Object.hasOwn(publicPayload, "check_session"), false);
});

test("legacy observations do not acquire invented continuity evidence", async () => {
    const legacy = Object.create(Heartbeat.prototype);
    for (const payload of [legacy.toJSON(), await legacy.toJSONAsync()]) {
        assert.equal(payload.check_interval, null);
        assert.equal(payload.check_session, null);
    }
});
