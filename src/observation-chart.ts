import { observationTime } from "./overview-state.ts";

type Observation = {
    time?: string;
    ping?: unknown;
    status?: unknown;
    check_session?: unknown;
    check_interval?: unknown;
    id?: unknown;
};
type Point = {
    x: number;
    y: number | null;
    time: number;
    status: number;
    session: string;
    interval: number | null;
    key: string;
};

/**
 * Saved measurements only. Missing values and session boundaries never become a connecting response line.
 * @param observations Saved observations
 * @param now UTC time
 * @param interval Expected cadence in seconds
 * @returns Measured points and explicit gaps
 */
export function observationChart(observations: Observation[], now = Date.now(), interval = 60) {
    const saved = observations
        .map((row, index) => ({ row, index, time: observationTime(row.time) }))
        .filter((item) => item.time !== null && item.time <= now)
        .sort((a, b) => (a.time as number) - (b.time as number) || a.index - b.index)
        .slice(-120);
    const first = saved[0]?.time ?? now;
    const last = saved.at(-1)?.time ?? now;
    const span = Math.max(last - first, Math.max(1, interval) * 1000);
    const start = last - span;
    const measured = saved
        .map(({ row }) => row.ping)
        .filter((ping): ping is number => typeof ping === "number" && Number.isFinite(ping) && ping >= 0);
    const ceiling = Math.max(1, Math.ceil(Math.max(0, ...measured) * 1.1));
    const points: Point[] = saved.map(({ row, index, time }) => ({
        x: 48 + (((time as number) - start) / span) * 560,
        y:
            typeof row.ping === "number" && Number.isFinite(row.ping) && row.ping >= 0
                ? 188 - (row.ping / ceiling) * 162
                : null,
        time: time as number,
        status: Number(row.status),
        session: typeof row.check_session === "string" ? row.check_session : "",
        interval:
            typeof row.check_interval === "number" && Number.isFinite(row.check_interval) && row.check_interval > 0
                ? row.check_interval
                : null,
        key: String(row.id ?? index) + ":" + String(time),
    }));
    const segments: { path: string; status: number }[] = [];
    const gaps: { x: number; width: number }[] = [];
    let previous: Point | null = null;
    let path = "";
    let tone = 1;
    for (const point of points) {
        const discontinuity =
            previous &&
            (!previous.interval ||
                point.time - previous.time > previous.interval * 1000 ||
                !point.session ||
                point.session !== previous.session);
        if (discontinuity && point.x > previous!.x) {
            gaps.push({ x: previous!.x, width: point.x - previous!.x });
        }
        if (point.y === null || discontinuity || (previous && point.status !== previous.status)) {
            if (path) segments.push({ path, status: tone });
            path = "";
        }
        if (point.y !== null) {
            tone = point.status;
            path += (path ? " L" : "M") + point.x.toFixed(2) + " " + point.y.toFixed(2);
        }
        previous = point;
    }
    if (path) segments.push({ path, status: tone });
    return {
        points,
        segments,
        gaps,
        start,
        end: last,
        ceiling,
        measurements: measured.length,
        failures: points.filter((point) => point.status === 0),
    };
}
