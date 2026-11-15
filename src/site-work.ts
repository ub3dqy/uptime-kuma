export const workKinds = ["update", "backup", "maintenance", "rollback"] as const;
export const workPhases = ["preparing", "applying", "verifying", "opening", "rolling_back", "working"] as const;
export const workMaximumDuration = 2 * 60 * 60 * 1000;

export interface SiteWork {
    kind: (typeof workKinds)[number];
    phase: (typeof workPhases)[number];
    startedAt: number;
    deadline: number;
    runID: string;
}

/**
 * @param value Untrusted input
 * @returns Bounded, secret-free work evidence or null
 */
export function validatedWork(value: unknown): SiteWork | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const work = value as SiteWork;
    if (
        !workKinds.includes(work.kind) ||
        !workPhases.includes(work.phase) ||
        !Number.isSafeInteger(work.startedAt) ||
        work.startedAt < 1 ||
        !Number.isSafeInteger(work.deadline) ||
        !Number.isFinite(new Date(work.deadline).getTime()) ||
        work.deadline <= work.startedAt ||
        work.deadline - work.startedAt > workMaximumDuration ||
        typeof work.runID !== "string" ||
        !/^[a-f0-9]{64}$/.test(work.runID)
    )
        return null;
    return {
        kind: work.kind,
        phase: work.phase,
        startedAt: work.startedAt,
        deadline: work.deadline,
        runID: work.runID,
    };
}

/**
 * @param work Validated server evidence
 * @returns A fixed marker, never a remote response body
 * @throws {Error} Invalid work evidence
 */
export function workMessage(work: SiteWork): string {
    const safe = validatedWork(work);
    if (!safe) throw new Error("Invalid work evidence");
    return `KUMA_WORK_V1:${safe.kind}:${safe.phase}:${safe.startedAt}:${safe.deadline}:${safe.runID}`;
}

/**
 * @param beat Saved observation
 * @returns Evidence only from an actual maintenance observation
 */
export function workFromBeat(beat?: { status?: number; msg?: string } | null): SiteWork | null {
    if (beat?.status !== 3 || typeof beat.msg !== "string" || beat.msg.length > 220) return null;
    const parts = beat.msg.split(":");
    if (parts.length !== 6 || parts[0] !== "KUMA_WORK_V1") return null;
    if (!/^\d{1,16}$/.test(parts[3]) || !/^\d{1,16}$/.test(parts[4])) return null;
    return validatedWork({
        kind: parts[1],
        phase: parts[2],
        startedAt: Number(parts[3]),
        deadline: Number(parts[4]),
        runID: parts[5],
    });
}

/**
 * @param beat Saved observation
 * @returns Fixed translation key or null
 */
export function workLabel(beat?: { status?: number; msg?: string } | null): string | null {
    const work = workFromBeat(beat);
    return work ? `siteWorkKind_${work.kind}` : null;
}
