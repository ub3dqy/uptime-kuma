const { test } = require("node:test");
const assert = require("node:assert/strict");
const { observationChart } = require("../../src/observation-chart.ts");

test("response chart preserves missing measurements, pauses between sessions and failed observations", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    const beat = (age, ping, status = 1, session = "one") => ({
        time: new Date(now - age * 1000).toISOString(),
        ping,
        status,
        check_session: session,
        check_interval: 20,
    });
    const chart = observationChart(
        [
            beat(300, 100),
            beat(280, 120),
            beat(260, null, 0),
            beat(240, 130),
            beat(80, 90),
            beat(60, 110, 1, "two"),
            beat(40, 125, 1, "two"),
            beat(-20, 9999),
            { time: "invalid", ping: 9999 },
        ],
        now,
        20
    );
    assert.equal(chart.measurements, 6);
    assert.equal(chart.failures.length, 1);
    assert.equal(chart.failures[0].y, null);
    assert.equal(chart.gaps.length, 2);
    assert.equal(chart.segments.length, 4);
    assert.equal(chart.ceiling, 143);
    assert.ok(chart.segments.every((segment) => !segment.path.includes("NaN")));
    assert.equal(observationChart([], now).measurements, 0);
    assert.equal(observationChart([beat(0, null, 0)], now).segments.length, 0);
});
