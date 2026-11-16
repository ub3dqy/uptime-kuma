const { test } = require("node:test");
const assert = require("node:assert/strict");
const { observationTrace, responseBuckets } = require("../../src/observation-chart.ts");

test("the detail view retains 120 actual checks while the overview only shows the latest 24", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    const readings = Array.from({ length: 130 }, (_, index) => ({
        time: new Date(now - (129 - index) * 20150).toISOString(),
        ping: 50 + index,
        status: 1,
        check_session: index < 50 ? "first" : "second",
        check_interval: 20,
    }));
    const detail = observationTrace(readings, now, 120);
    const compact = observationTrace(readings, now);
    assert.equal(detail.samples.length, 120);
    assert.equal(detail.start, Date.parse(readings[10].time));
    assert.equal(detail.paths.length, 2);
    assert.equal(detail.gaps.length, 1);
    assert.equal(detail.gaps[0].endTime, Date.parse(readings[50].time));
    assert.equal(compact.gaps.length, 0);
    assert.deepEqual(
        detail.samples.slice(-24).map(({ time, ping, state }) => ({ time, ping, state })),
        compact.samples.map(({ time, ping, state }) => ({ time, ping, state }))
    );
});

test("period history keeps failures, empty buckets, mixed results and zero response distinct", () => {
    const timestamp = 1793613600;
    const rows = [
        { timestamp: timestamp + 360, up: 0, down: 2, avgPing: 0 },
        { timestamp: timestamp + 300, up: 1, down: 1, minPing: 40, avgPing: 45, maxPing: 50 },
        { timestamp: timestamp + 60, up: 0, down: 0 },
        { timestamp, up: 1, down: 0, minPing: 0, avgPing: 0, maxPing: 0 },
    ];
    const points = responseBuckets(rows, 60);
    assert.deepEqual(
        points.map((point) => [point.x, point.avg, point.tone]),
        [
            [timestamp * 1000, 0, null],
            [(timestamp + 60) * 1000, null, null],
            [(timestamp + 300) * 1000, 45, "mixed"],
            [(timestamp + 360) * 1000, null, "down"],
        ]
    );
    assert.equal(points[2].min, 40);
    assert.equal(points[2].max, 50);
});

test("compact history keeps exact timing, outages and real gaps without joining them", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const beat = (seconds, ping, status = 1, session = "one") => ({
        time: new Date(now + seconds * 1000).toISOString(),
        ping,
        status,
        check_session: session,
        check_interval: 20,
    });
    const entries = [
        beat(-181, 0),
        beat(-160.45, 48),
        beat(-140.45, null, 0),
        beat(-120.45, 32),
        beat(-60, 62),
        beat(-40, 80, 1, "two"),
        beat(-20, 50, 1, "two"),
        beat(-10, 999, 3, "two"),
        beat(1, 900),
        { time: "unknown", ping: 100 },
    ];
    entries[2].msg = "HTTP 404 https://example.test/?secret=test";
    const input = [entries[6], ...entries, { ...entries[6], time: "2026-11-13 11:59:40" }];
    const before = JSON.stringify(input);
    const trace = observationTrace(input, now);
    assert.equal(JSON.stringify(input), before);
    assert.equal(trace.samples.length, 8);
    assert.equal(trace.measurements, 6);
    assert.equal(trace.samples[0].ping, 0);
    assert.equal(trace.samples[2].y, null);
    assert.equal(trace.samples[2].issue, "workspaceIssue404");
    assert.equal(trace.samples.at(-1).ping, null);
    assert.equal(trace.paths.length, 2);
    assert.equal(trace.gaps.length, 2);
    assert.ok(trace.gaps[0].width > trace.gaps[1].width);
    assert.equal(trace.tail, "");
    assert.doesNotMatch(JSON.stringify(trace), /example\.test|secret|NaN/);
});

test("compact history bounds the latest readings without inventing a response for empty or failed checks", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const outage = Array.from({ length: 32 }, (_, index) => ({
        time: new Date(now - index * 60000).toISOString(),
        status: 0,
        ping: null,
        check_session: "one",
        check_interval: 60,
    }));
    const trace = observationTrace(outage, now);
    assert.equal(trace.samples.length, 24);
    assert.equal(trace.start, now - 23 * 60000);
    assert.equal(trace.end, now);
    assert.equal(trace.paths.length, 0);
    assert.equal(trace.measurements, 0);
    assert.equal(observationTrace([], now).start, null);
});
