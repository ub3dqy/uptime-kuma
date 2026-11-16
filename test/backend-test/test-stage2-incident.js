const { test } = require("node:test");
const assert = require("node:assert/strict");
const { incidentEvidence, incidentActions } = require("../../src/incident-state.ts");
const { responseTimeLimit, enforceResponseTime } = require("../../server/response-time-policy");
const now = Date.parse("2026-11-01T12:00:00Z");
const monitor = {
    id: 1,
    type: "http",
    active: 1,
    interval: 60,
    url: "https://user:secret@example.test/private?token=hidden",
};
const beat = (time, status, extra = {}) => ({
    time: `2026-11-01 11:${time}:00`,
    status,
    check_interval: 60,
    check_session: "run",
    ...extra,
});

test("incident facts separate a retry, confirmed failure and the preceding success", () => {
    const beats = [
        beat("56", 1),
        beat("57", 2),
        beat("58", 0, { msg: "HTTP 404" }),
        beat("59", 0, { msg: "HTTP 404" }),
    ];
    const result = incidentEvidence(monitor, beats, now);
    assert.equal(result.state, "down");
    assert.equal(result.lastGood.time, beats[0].time);
    assert.equal(result.firstObserved.time, beats[1].time);
    assert.equal(result.firstConfirmed.time, beats[2].time);
    assert.equal(result.host, "example.test");
    assert.equal(result.historyLimited, false);
    assert.deepEqual(incidentActions(result.explanation), ["stage2ActionAddress", "stage2ActionDeployment"]);
    assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("retained history cannot invent exact incident start across a gap or unknown run", () => {
    for (const beats of [
        [beat("59", 0)],
        [beat("55", 1), beat("56", 0), beat("59", 0)],
        [beat("57", 1), beat("58", 0), beat("59", 0, { check_session: "new-run" })],
        [beat("55", 1), beat("59", 0)],
        [beat("58", 1), beat("59", 0, { check_session: "new-run" })],
        [beat("57", 1), beat("58", 3), beat("59", 0)],
    ]) {
        assert.equal(incidentEvidence(monitor, beats, now).historyLimited, true);
    }
    assert.equal(incidentEvidence(monitor, [beat("59", 2)], now).firstConfirmed, undefined);
    assert.equal(incidentEvidence(monitor, [beat("58", 0), beat("59", 1)], now).firstObserved, undefined);
});

test("incident state stays truthful when disconnected, paused by parent or stale", () => {
    assert.equal(incidentEvidence(monitor, [beat("59", 1)], now, false).state, "unknown");
    assert.equal(incidentEvidence({ ...monitor, forceInactive: true }, [beat("59", 1)], now).state, "paused");
    assert.equal(incidentEvidence(monitor, [beat("30", 1)], now).state, "unknown");
    assert.equal(incidentEvidence(monitor, [beat("59", 3)], now).state, "maintenance");
    const hostile = incidentEvidence(monitor, [beat("59", 0, { msg: "RESPONSE_TIME_LIMIT: 1500 ms > 1000 ms" })], now);
    assert.equal(hostile.explanation, "workspaceIssueSlow");
    assert.deepEqual(incidentActions(hostile.explanation), ["stage2ActionLoad", "stage2ActionSpeed"]);
});

test("HTTP response limits reject invalid configuration and fail only an actual excess", () => {
    for (const value of [undefined, null, ""]) {
        assert.equal(responseTimeLimit("http", value), null);
    }
    for (const value of [0, -1, Infinity, NaN, 3.5, "1000", true, 3600001]) {
        assert.throws(() => responseTimeLimit("http", value), /stage2ResponseLimitInvalid/);
    }
    assert.throws(() => responseTimeLimit("dns", 1000), /stage2ResponseLimitInvalid/);
    assert.throws(
        () => responseTimeLimit("http", -1),
        (error) => error.msgi18n === true
    );
    assert.doesNotThrow(() => enforceResponseTime(1000, 1000));
    assert.doesNotThrow(() => enforceResponseTime(null, 5000));
    assert.doesNotThrow(() => enforceResponseTime(1, 0));
    assert.throws(() => enforceResponseTime(1000, 1001), /RESPONSE_TIME_LIMIT/);
});
