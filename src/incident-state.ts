import {
    currentServiceState,
    issueExplanation,
    observationTime,
    serviceHost,
    type OverviewBeat,
    type OverviewMonitor,
} from "./overview-state.ts";
import { workLabel } from "./site-work.ts";

/**
 * Describe saved evidence without pretending a retained slice establishes exact downtime.
 * @param monitor Owned check
 * @param beats Retained observations
 * @param now Current UTC time
 * @param connected Live connection state
 * @returns Incident evidence and safe display information
 */
export function incidentEvidence(monitor: OverviewMonitor, beats: OverviewBeat[], now = Date.now(), connected = true) {
    const ordered = beats
        .filter((beat) => {
            const time = observationTime(beat.time);
            return time !== null && time <= now;
        })
        .slice()
        .sort((a, b) => observationTime(a.time)! - observationTime(b.time)!);
    const current = currentServiceState(monitor, ordered, now, connected);
    const lastGood = ordered.findLast((beat) => beat.status === 1);
    const lastBad = ordered.findLast((beat) => beat.status === 0);
    const tail: OverviewBeat[] = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
        if (![0, 2].includes(ordered[i].status!)) {
            break;
        }
        tail.unshift(ordered[i]);
    }
    const firstObserved = tail[0];
    const firstConfirmed = tail.find((beat) => beat.status === 0);
    const preceding = ordered[ordered.length - tail.length - 1];
    const interrupted = tail.some((beat, index) => {
        const prior = index ? tail[index - 1] : preceding;
        return (
            !beat.check_session ||
            (prior &&
                (prior.check_session !== beat.check_session ||
                    !prior.check_interval ||
                    observationTime(beat.time)! - observationTime(prior.time)! > prior.check_interval * 1000))
        );
    });
    return {
        ...current,
        host: serviceHost(monitor),
        lastGood,
        lastBad,
        firstObserved,
        firstConfirmed,
        historyLimited: Boolean(firstObserved && (preceding?.status !== 1 || interrupted)),
        explanation: issueExplanation(current.state, current.latest?.msg),
        recent: ordered
            .slice(-8)
            .reverse()
            .map((beat) => ({ time: beat.time, status: beat.status, ping: beat.ping, workLabel: workLabel(beat) })),
    };
}

/**
 * Fixed next steps are guidance, never automatic execution or an AI diagnosis.
 * @param explanation Safe reason key
 * @returns Translation keys for human next actions
 */
export function incidentActions(explanation: string) {
    const mapping: Record<string, string[]> = {
        workspaceIssue404: ["stage2ActionAddress", "stage2ActionDeployment"],
        workspaceIssueAccess: ["stage2ActionAuthorization", "stage2ActionOwner"],
        workspaceIssueRate: ["stage2ActionRate", "stage2ActionOwner"],
        workspaceIssueDNS: ["stage2ActionDNS", "stage2ActionOwner"],
        workspaceIssueTLS: ["stage2ActionTLS", "stage2ActionOwner"],
        workspaceIssueTimeout: ["stage2ActionLoad", "stage2ActionConnection"],
        workspaceIssueSlow: ["stage2ActionLoad", "stage2ActionSpeed"],
        workspaceIssueUnknown: ["stage2ActionMonitoring", "stage2ActionConnection"],
    };
    return mapping[explanation] || ["stage2ActionLogs", "stage2ActionConnection"];
}
