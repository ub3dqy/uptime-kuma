export type OverviewState = "up" | "down" | "pending" | "unknown" | "paused" | "maintenance";

export interface OverviewMonitor {
    id: number;
    name?: string;
    type?: string;
    active?: boolean | number;
    interval?: number;
    timeout?: number;
    forceInactive?: boolean;
    url?: string;
    hostname?: string;
}

export interface OverviewBeat {
    time?: string;
    status?: number;
    ping?: number | null;
    msg?: string;
    check_interval?: number | null;
    check_session?: string | null;
}

/**
 * Parse the server's UTC timestamps without applying the browser's local zone.
 * @param value Saved server timestamp
 * @returns UTC milliseconds or null for invalid input
 */
export function observationTime(value?: string): number | null {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
    ) {
        return null;
    }
    const date = value.slice(0, 10);
    const calendar = new Date(date + "T00:00:00Z");
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) {
        return null;
    }
    const normalized = value.replace(" ", "T");
    const time = Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : normalized + "Z");
    return Number.isFinite(time) ? time : null;
}

/**
 * Display a host only: URLs can contain passwords, signed query strings or push tokens.
 * @param monitor Owned monitor metadata
 * @returns Safe hostname without credentials, paths or query strings
 */
export function serviceHost(monitor: OverviewMonitor): string {
    try {
        const url = new URL(monitor.url || "");
        if (["https:", "http:"].includes(url.protocol)) {
            return url.host;
        }
    } catch {
        // Non-HTTP monitors can have a plain hostname instead.
    }
    return typeof monitor.hostname === "string" && /^[a-z\d.[\]:_-]{1,253}$/i.test(monitor.hostname)
        ? monitor.hostname
        : "";
}

/**
 * Recognize only the three bundled canary endpoints; this never changes permissions.
 * @param monitor Owned monitor metadata
 * @returns Whether it is a bundled demonstration check
 */
export function isBuiltInDemo(monitor: OverviewMonitor): boolean {
    try {
        const url = new URL(monitor.url || "");
        return (
            Boolean(monitor.name?.startsWith("Pilot/")) &&
            url.hostname === "canary" &&
            url.port === "8080" &&
            ["/always-up", "/always-down", "/cycle"].includes(url.pathname)
        );
    } catch {
        return false;
    }
}

/**
 * Get a current state, preserving pause/maintenance and refusing stale or future success.
 * @param monitor Owned monitor metadata
 * @param beats Preserved observations
 * @param now Current UTC milliseconds
 * @param connected Whether current observations can be received
 * @returns State and the latest valid observation
 */
export function currentServiceState(
    monitor: OverviewMonitor,
    beats: OverviewBeat[] = [],
    now = Date.now(),
    connected = true
) {
    const ordered = beats
        .map((beat) => ({ beat, time: observationTime(beat.time) }))
        .filter((entry) => entry.time !== null && entry.time <= now)
        .sort((a, b) => a.time! - b.time!);
    const entry = ordered.at(-1);
    let state: OverviewState = "unknown";
    if (monitor.active === false || monitor.active === 0 || monitor.forceInactive) {
        state = "paused";
    } else if (connected && entry) {
        const interval = Number(monitor.interval);
        const timeout = Number(monitor.timeout);
        const freshness = Math.min(
            86400000,
            Math.max(
                120000,
                ((Number.isFinite(interval) && interval > 0 ? interval : 60) * 3 +
                    (Number.isFinite(timeout) && timeout > 0 ? timeout : 0)) *
                    1000
            )
        );
        if (now - entry.time! <= freshness) {
            state =
                ({ 0: "down", 1: "up", 2: "pending", 3: "maintenance" } as Record<number, OverviewState>)[
                    entry.beat.status!
                ] || "unknown";
        }
    }
    return { state, latest: entry?.beat, checkedAt: entry?.time ?? null };
}

/**
 * A bounded, deterministic explanation of saved evidence; never an AI claim or a command.
 * @param state Current display state
 * @param message Untrusted saved error message
 * @returns A fixed translation key, never raw remote content
 */
export function issueExplanation(state: OverviewState, message = ""): string {
    if (state === "unknown") {
        return "workspaceIssueUnknown";
    }
    if (state === "pending") {
        return "workspaceIssuePending";
    }
    const text = typeof message === "string" ? message.slice(0, 2048) : "";
    if (text.includes("PROJECT_TARGET_BLOCKED")) {
        return "workspaceIssueProjectTarget";
    }
    if (text.startsWith("RESPONSE_TIME_LIMIT:")) {
        return "workspaceIssueSlow";
    }
    const status = text.match(/\b(?:status(?:\s+code)?|HTTP(?:\/[\d.]+)?)\s*[:=]?\s*(\d{3})\b/i)?.[1];
    if (status === "404") {
        return "workspaceIssue404";
    }
    if (status === "401" || status === "403") {
        return "workspaceIssueAccess";
    }
    if (status === "429") {
        return "workspaceIssueRate";
    }
    if (status?.startsWith("5")) {
        return "workspaceIssueServer";
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
        return "workspaceIssueDNS";
    }
    if (/certificate|CERT_|\bTLS\b|\bSSL\b/i.test(text)) {
        return "workspaceIssueTLS";
    }
    if (/timeout|timed out|ETIMEDOUT/i.test(text)) {
        return "workspaceIssueTimeout";
    }
    return "workspaceIssueUnreachable";
}
