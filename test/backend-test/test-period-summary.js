const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { buildPeriodSummary } = require("../../server/period-summary");

const origin = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (seconds) => new Date(origin + seconds * 1000).toISOString();
/**
 * @param {number} seconds Offset
 * @param {number} status State
 * @param {object} overrides Metadata
 * @returns {object} Saved row
 */
function beat(seconds, status = 1, overrides = {}) {
    return {
        time: iso(seconds).replace("T", " ").replace("Z", ""),
        status,
        check_interval: 60,
        check_session: "run-a",
        ping: 10,
        ...overrides,
    };
}
/**
 * @param {object} result Summary
 * @returns {void} All time is accounted for exactly once
 */
function balanced(result) {
    const { total, ...parts } = result.time;
    assert.equal(
        Object.values(parts).reduce((a, b) => a + b, 0),
        total
    );
    assert.ok(Object.values(parts).every((duration) => duration >= 0));
}

describe("Period summaries with bounded observation coverage", () => {
    test("caps long gaps, clips boundaries, excludes successor counts and never fills the last tail", () => {
        const result = buildPeriodSummary([beat(-30), beat(30), beat(330, 0), beat(390, 0)], iso(0), iso(450));
        assert.deepEqual(result.time, {
            up: 90_000,
            down: 60_000,
            pending: 0,
            maintenance: 0,
            unknown: 300_000,
            total: 450_000,
        });
        assert.equal(result.availability, 0.6);
        assert.equal(result.coverage, 1 / 3);
        assert.equal(result.counts.total, 3);
        balanced(result);
        const clipped = buildPeriodSummary([beat(0), beat(60, 0)], iso(15.125), iso(45.875));
        assert.equal(clipped.time.up, 30_750);
        assert.equal(clipped.time.unknown, 0);
        assert.equal(clipped.counts.total, 0);
    });

    test("leaves empty, single, deleted and legacy history unknown instead of reporting 100%", () => {
        for (const rows of [[], [beat(0)], [beat(0, 1, { check_interval: null, check_session: null }), beat(60)]]) {
            const result = buildPeriodSummary(rows, iso(0), iso(120));
            assert.equal(result.availability, null);
            assert.equal(result.coverage, 0);
            assert.equal(result.time.unknown, 120_000);
            balanced(result);
        }
        const legacy = buildPeriodSummary(
            [beat(0, 1, { check_interval: null }), beat(60, 0, { check_session: null })],
            iso(0),
            iso(120)
        );
        assert.equal(legacy.legacyChecks, 2);
        assert.deepEqual(legacy.counts, { up: 1, down: 1, pending: 0, maintenance: 0, unknown: 0, total: 2 });
        assert.equal(legacy.response.mean, 10);
    });

    test("breaks coverage at pauses, restarts and schedule edits even across a short gap", () => {
        const result = buildPeriodSummary(
            [
                beat(0),
                beat(20, 1, { check_session: "run-b", check_interval: 10 }),
                beat(40, 0, { check_session: "run-b", check_interval: 600 }),
            ],
            iso(0),
            iso(60)
        );
        assert.equal(result.time.up, 10_000);
        assert.equal(result.time.unknown, 50_000);
        balanced(result);
    });

    test("does not count retries, maintenance or unknown states as successful availability", () => {
        const rows = [
            beat(0, 2, { check_interval: 10 }),
            beat(10, 3),
            beat(70, 99),
            beat(80, 1),
            beat(140, 0),
            beat(200, 0),
        ];
        const result = buildPeriodSummary(rows, iso(0), iso(200));
        assert.deepEqual(result.time, {
            up: 60_000,
            down: 60_000,
            pending: 10_000,
            maintenance: 60_000,
            unknown: 10_000,
            total: 200_000,
        });
        assert.equal(result.availability, 0.5);
        assert.equal(result.counts.unknown, 1);
        const onlyMaintenance = buildPeriodSummary([beat(0, 3), beat(60, 3)], iso(0), iso(60));
        assert.equal(onlyMaintenance.availability, null);
        assert.equal(onlyMaintenance.coverage, 1);
        balanced(result);
    });

    test("keeps millisecond precision and resolves equal timestamps by the supplied id order", () => {
        const result = buildPeriodSummary([beat(0), beat(0, 0), beat(0.125, 2), beat(0.5)], iso(0), iso(1));
        assert.equal(result.time.down, 125);
        assert.equal(result.time.pending, 375);
        assert.equal(result.time.unknown, 500);
        balanced(result);
    });

    test("uses only finite nonnegative successful response samples, including zero, for nearest-rank p95", () => {
        const pings = Array.from({ length: 20 }, (_, index) => beat(index, 1, { ping: index }));
        const result = buildPeriodSummary(
            [
                ...pings,
                beat(20, 0, { ping: 999 }),
                beat(21, 2, { ping: 888 }),
                beat(22, 3, { ping: 777 }),
                beat(23, 1, { ping: null }),
                beat(24, 1, { ping: -1 }),
                beat(25, 1, { ping: NaN }),
                beat(26, 1, { ping: Infinity }),
            ],
            iso(0),
            iso(30)
        );
        assert.deepEqual(result.response, { samples: 20, mean: 9.5, min: 0, max: 19, p95: 18 });
        assert.equal(buildPeriodSummary([beat(0, 0)], iso(0), iso(60)).response.mean, null);
    });

    test("is timezone independent, accepts SQL legacy seconds and Date values, and refuses malformed history", () => {
        const rows = [beat(0, 1, { time: "2026-01-01 00:00:00" }), beat(60, 0, { time: new Date(iso(60)) })];
        assert.equal(buildPeriodSummary(rows, iso(0), iso(60)).time.up, 60_000);
        for (const time of ["2026-02-30 00:00:00", "not-a-date", "2026-01-01T00:00:00+03:00", new Date(NaN)]) {
            assert.throws(() => buildPeriodSummary([beat(0, 1, { time })], iso(0), iso(60)), /periodSummaryFailed/);
        }
        assert.throws(() => buildPeriodSummary([beat(60), beat(0)], iso(0), iso(120)), /periodSummaryFailed/);
        assert.throws(() => buildPeriodSummary(new Array(50003), iso(0), iso(60)), /periodSummaryTooLarge/);
    });

    test("unknown or invalid schedule metadata never creates time coverage", () => {
        for (const metadata of [
            { check_interval: 0 },
            { check_interval: -1 },
            { check_interval: Infinity },
            { check_interval: "bad" },
            { check_session: "" },
            { check_session: null },
        ]) {
            const result = buildPeriodSummary([beat(0, 1, metadata), beat(60)], iso(0), iso(120));
            assert.equal(result.time.unknown, 120_000);
        }
        const unknown = buildPeriodSummary([beat(0, "__proto__"), beat(60)], iso(0), iso(120));
        assert.equal(unknown.counts.unknown, 1);
        assert.equal(unknown.time.unknown, 120_000);
    });
});
