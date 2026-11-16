import { currentServiceState, observationTime } from "./overview-state.ts";
type TrackedMonitor = { active?: boolean | number; interval?: number; timeout?: number; forceInactive?: boolean };

/**
 * Read a trend from 15 consecutive measured successes only.
 * @param monitor Current check configuration
 * @param observations Chronological saved observations
 * @param now UTC time
 * @returns An advisory comparison; never an invented failure or synthetic latency
 */
export function latencyTrend(
    monitor: TrackedMonitor,
    observations: { time?: string; status?: number; ping?: number; check_session?: string; check_interval?: number }[],
    now = Date.now()
) {
    const beats = observations.slice(-15);
    if (beats.length !== 15 || currentServiceState(monitor, beats, now).state !== "up")
        return { state: "insufficient" };
    for (let index = 0; index < beats.length; index++) {
        const beat = beats[index];
        const time = observationTime(beat.time);
        if (
            beat.status !== 1 ||
            typeof beat.ping !== "number" ||
            !Number.isFinite(beat.ping) ||
            beat.ping < 0 ||
            !beat.check_session ||
            time === null ||
            time > now
        )
            return { state: "insufficient" };
        if (index) {
            const previous = beats[index - 1];
            const interval = previous.check_interval;
            const before = observationTime(previous.time)!;
            if (
                previous.check_session !== beat.check_session ||
                typeof interval !== "number" ||
                !Number.isFinite(interval) ||
                interval <= 0 ||
                time <= before ||
                time - before > interval * 1000 + 1000
            )
                return { state: "insufficient" };
        }
    }
    const median = (rows: typeof beats) => {
        const values = rows.map((row) => row.ping!).sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    };
    const before = median(beats.slice(0, 10));
    const recent = median(beats.slice(10));
    return {
        state: recent >= before * 1.5 && recent - before >= 100 ? "increased" : "stable",
        before,
        recent,
        samples: 15,
    };
}
