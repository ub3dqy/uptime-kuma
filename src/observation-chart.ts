import { issueExplanation, observationTime } from "./overview-state.ts";

type Observation = {
    time?: string;
    ping?: unknown;
    status?: unknown;
    check_session?: unknown;
    check_interval?: unknown;
};

type TraceState = "up" | "down" | "pending" | "maintenance" | "unknown";
type TraceSample = {
    kind: "sample";
    key: string;
    time: number;
    x: number;
    y: number | null;
    ping: number | null;
    state: TraceState;
    issue?: string;
};
type TraceGap = { kind: "gap"; key: string; time: number; endTime: number; x: number; left: number; width: number };

/**
 * Build a compact timeline on one real time scale for both the line and status marks.
 * @param observations Saved observations (including any duplicate delivered during reconnect)
 * @param now Current time in UTC milliseconds
 * @param limit Number of recent samples to display, at most 120
 * @returns Plot points, inspectable gaps and response paths from measured values only
 */
export function observationTrace(observations: (Observation & { msg?: string })[], now = Date.now(), limit = 24) {
    // The live event and its history row carry the same timestamp, even when formatted differently.
    const unique = new Map<number, Observation & { msg?: string }>();
    for (const row of observations) {
        const time = observationTime(row.time);
        if (time !== null && time <= now) {
            unique.set(time, row);
        }
    }
    const saved = [...unique.entries()].sort(([a], [b]) => a - b).slice(-Math.min(120, Math.max(1, limit)));
    const start = saved[0]?.[0] ?? null;
    const end = saved.at(-1)?.[0] ?? null;
    const span = start === null || end === null ? 0 : end - start;
    const measured = saved.map(([, row]) =>
        (row.status === 0 || row.status === 1 || row.status === 2) &&
        typeof row.ping === "number" &&
        Number.isFinite(row.ping) &&
        row.ping >= 0
            ? row.ping
            : null
    );
    const maximum = Math.max(0, ...measured.map((ping) => ping ?? 0));
    // A readable scale starts at zero and rounds the upper bound to a familiar increment.
    const step = Math.max(1, 10 ** Math.floor(Math.log10(Math.max(10, maximum) / 2)));
    const rounded = Math.ceil(maximum / step) * step;
    const ceiling = Math.max(10, Number.isFinite(rounded) ? rounded : maximum);
    const xAt = (time: number) => (span && start !== null ? 2 + ((time - start) / span) * 96 : 50);
    const states: Record<number, TraceState> = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };
    const entries: (TraceSample | TraceGap)[] = [];
    const samples: TraceSample[] = [];
    const gaps: TraceGap[] = [];
    const paths: { key: string; line: string; area: string }[] = [];
    let run: TraceSample[] = [];
    const flush = () => {
        if (run.length >= 2) {
            const line = "M" + run.map((point) => `${point.x.toFixed(3)} ${point.y!.toFixed(3)}`).join(" L");
            const last = run[run.length - 1];
            paths.push({ key: run[0].key, line, area: `${line} L${last.x} 92 L${run[0].x} 92 Z` });
        }
        run = [];
    };
    for (let i = 0; i < saved.length; i++) {
        const [time, row] = saved[i];
        const key = `time:${time}`;
        const previous = saved[i - 1];
        const x = xAt(time);
        if (previous) {
            const [previousTime, previousRow] = previous;
            const interval = previousRow.check_interval;
            // Scheduling has a small amount of drift; longer pauses and different runs remain separate.
            const continuous =
                typeof previousRow.check_session === "string" &&
                previousRow.check_session &&
                previousRow.check_session === row.check_session &&
                typeof interval === "number" &&
                Number.isFinite(interval) &&
                interval > 0 &&
                time - previousTime <= interval * 1000 + Math.min(1000, interval * 100);
            if (!continuous) {
                flush();
                const left = xAt(previousTime);
                if (x > left) {
                    const gap: TraceGap = {
                        kind: "gap",
                        key: `gap:${previousTime}:${time}`,
                        time: previousTime,
                        endTime: time,
                        x: (left + x) / 2,
                        left,
                        width: x - left,
                    };
                    gaps.push(gap);
                    entries.push(gap);
                }
            }
        }
        const ping = measured[i];
        const state = typeof row.status === "number" ? (states[row.status] ?? "unknown") : "unknown";
        const sample: TraceSample = {
            kind: "sample",
            key,
            time,
            x,
            ping,
            state,
            y: ping === null ? null : 92 - (ping / ceiling) * 84,
            issue: state === "down" ? issueExplanation(state, row.msg) : undefined,
        };
        if (sample.y !== null && state === "up") {
            run.push(sample);
        } else {
            flush();
        }
        samples.push(sample);
        entries.push(sample);
    }
    const tail = run.length >= 2 ? run.slice(-2) : [];
    flush();
    return {
        start,
        end,
        ceiling,
        entries,
        samples,
        gaps,
        paths,
        tail: tail.length ? `M${tail[0].x} ${tail[0].y} L${tail[1].x} ${tail[1].y}` : "",
        measurements: measured.filter((ping) => ping !== null).length,
    };
}

type ChartBucket = {
    timestamp: number;
    up: number;
    down: number;
    maintenance?: number;
    avgPing?: number | null;
    minPing?: number | null;
    maxPing?: number | null;
};

/**
 * Order retained aggregates by their real UTC time and insert a null point wherever a bucket was skipped.
 * @param buckets Nonempty minute or hour aggregates returned by the server
 * @param bucketSeconds Bucket duration from the selected period
 * @returns Aligned samples for the response series and status bars
 */
export function responseBuckets(buckets: ChartBucket[], bucketSeconds: number) {
    const ordered = [...buckets].sort((a, b) => a.timestamp - b.timestamp);
    const points: {
        x: number;
        min: number | null;
        avg: number | null;
        max: number | null;
        tone: "maintenance" | "down" | "mixed" | null;
    }[] = [];
    let previous: number | undefined;
    for (const bucket of ordered) {
        const time = bucket.timestamp;
        if (!Number.isFinite(time) || time === previous || !(bucket.up || bucket.down || bucket.maintenance)) continue;
        if (previous !== undefined && time - previous > bucketSeconds) {
            points.push({ x: (previous + bucketSeconds) * 1000, min: null, avg: null, max: null, tone: null });
        }
        const measured = (value?: number | null) =>
            bucket.up > 0 && typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
        points.push({
            x: time * 1000,
            min: measured(bucket.minPing),
            avg: measured(bucket.avgPing),
            max: measured(bucket.maxPing),
            tone: bucket.maintenance ? "maintenance" : bucket.down ? (bucket.up ? "mixed" : "down") : null,
        });
        previous = time;
    }
    return points;
}
