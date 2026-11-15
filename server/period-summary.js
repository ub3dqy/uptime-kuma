const { UP, DOWN, PENDING, MAINTENANCE } = require("../src/util");
const { MAX_EXPORT_ROWS } = require("./heartbeat-export");

const states = new Map([
    [UP, "up"],
    [DOWN, "down"],
    [PENDING, "pending"],
    [MAINTENANCE, "maintenance"],
]);

/**
 * Read database UTC values without depending on the host timezone.
 * @param {string|Date} value Database timestamp
 * @returns {number} Unix milliseconds
 * @throws {Error} Invalid stored timestamp
 */
function heartbeatTime(value) {
    if (value instanceof Date) {
        return value.getTime();
    }
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) {
        throw new Error("periodSummaryFailed");
    }
    const timestamp = Date.parse(value.replace(" ", "T") + "Z");
    const canonical = value.length === 19 ? value + ".000" : value.padEnd(23, "0");
    if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().replace("T", " ").replace("Z", "") !== canonical
    ) {
        throw new Error("periodSummaryFailed");
    }
    return timestamp;
}

/**
 * Summarize retained observations. Carry a state forward only between two rows
 * in the same uninterrupted run, capped at the earlier row's saved interval.
 * Never extend the last row into an unobserved tail or infer old schedules.
 * @param {object[]} rows Ordered rows, optionally including one row on each side
 * @param {string} startISO Inclusive UTC boundary
 * @param {string} endISO Exclusive UTC boundary
 * @returns {object} Counts, sampled latency, bounded time estimates and coverage
 * @throws {Error} Invalid or excessive history
 */
function buildPeriodSummary(rows, startISO, endISO) {
    if (rows.length > MAX_EXPORT_ROWS + 2) {
        throw new Error("periodSummaryTooLarge");
    }
    const start = Date.parse(startISO);
    const end = Date.parse(endISO);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new Error("periodSummaryFailed");
    }
    const counts = { up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0, total: 0 };
    const time = { up: 0, down: 0, pending: 0, maintenance: 0, unknown: end - start, total: end - start };
    const pings = [];
    let legacyChecks = 0;
    let previous = null;
    for (const row of rows) {
        const timestamp = heartbeatTime(row.time);
        if (!Number.isFinite(timestamp) || (previous && timestamp < previous.timestamp)) {
            throw new Error("periodSummaryFailed");
        }
        const interval = Number(row.check_interval);
        const hasSchedule =
            Number.isFinite(interval) &&
            interval > 0 &&
            typeof row.check_session === "string" &&
            row.check_session.length > 0;
        if (timestamp >= start && timestamp < end) {
            counts[states.get(row.status) ?? "unknown"]++;
            counts.total++;
            if (!hasSchedule) {
                legacyChecks++;
            }
            if (row.status === UP && typeof row.ping === "number" && Number.isFinite(row.ping) && row.ping >= 0) {
                pings.push(row.ping);
            }
        }
        if (previous && previous.hasSchedule && hasSchedule && previous.row.check_session === row.check_session) {
            const state = states.get(previous.row.status);
            const from = Math.max(start, previous.timestamp);
            const until = Math.min(end, timestamp, previous.timestamp + previous.interval * 1000);
            if (state && until > from) {
                time[state] += until - from;
                time.unknown -= until - from;
            }
        }
        previous = { row, timestamp, interval, hasSchedule };
    }
    if (counts.total > MAX_EXPORT_ROWS) {
        throw new Error("periodSummaryTooLarge");
    }
    pings.sort((a, b) => a - b);
    const decided = time.up + time.down;
    return {
        start: startISO,
        end: endISO,
        counts,
        time,
        legacyChecks,
        availability: decided > 0 ? time.up / decided : null,
        coverage: (time.total - time.unknown) / time.total,
        response: {
            samples: pings.length,
            mean: pings.length ? pings.reduce((sum, ping) => sum + ping, 0) / pings.length : null,
            min: pings[0] ?? null,
            max: pings.at(-1) ?? null,
            p95: pings.length ? pings[Math.ceil(pings.length * 0.95) - 1] : null,
        },
    };
}

module.exports = { buildPeriodSummary };
