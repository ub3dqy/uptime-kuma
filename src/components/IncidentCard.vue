<template>
    <section class="ws-incident" data-testid="incident-card" :class="`ws-incident-${evidence.state}`">
        <div class="ws-incident-heading">
            <span class="ws-callout-icon"><WorkspaceIcon :name="icons[evidence.state]" /></span>
            <div>
                <p class="ws-eyebrow">{{ $t("stage2CurrentSituation") }}</p>
                <h2>{{ $t(savedWork ? `siteWorkKind_${savedWork.kind}` : titles[evidence.state]) }}</h2>
                <p>{{ evidence.host || $t("workspacePrivateService") }}</p>
            </div>
            <span class="ws-state" :class="`ws-state-${evidence.state}`">
                <span />
                {{ $t(savedWork ? `siteWorkKind_${savedWork.kind}` : labels[evidence.state]) }}
            </span>
        </div>
        <div
            v-if="shownWork"
            class="ws-site-work"
            :class="{ 'ws-site-work-overdue': workOverdue }"
            role="status"
            data-testid="site-work"
        >
            <strong>{{ $t(workOverdue ? "siteWorkOverdue" : `siteWorkPhase_${shownWork.phase}`) }}</strong>
            <p>{{ $t("siteWorkConfirmed") }}</p>
            <p>
                {{ $t("siteWorkDeadline") }}
                <Datetime :value="new Date(shownWork.deadline).toISOString()" />
            </p>
            <small>{{ $t(workOverdue ? "siteWorkOverdueHonesty" : "siteWorkChecksHonesty") }}</small>
        </div>
        <p v-if="['down', 'pending', 'unknown'].includes(evidence.state)" class="ws-incident-reason">
            {{ $t(evidence.explanation) }}
        </p>
        <div class="pm-incident-columns">
            <div class="pm-incident-evidence">
                <ObservationChart
                    :key="monitor.id"
                    :monitor-id="monitor.id"
                    :name="monitor.name"
                    :observations="savedObservations"
                    :now="now"
                />
                <dl class="ws-incident-facts">
                    <div>
                        <dt>{{ $t("stage2LastCheck") }}</dt>
                        <dd>
                            <Datetime v-if="evidence.latest" :value="evidence.latest.time" />
                            <span v-else>{{ $t("workspaceStateUnknown") }}</span>
                        </dd>
                    </div>
                    <div>
                        <dt>{{ $t("stage2LastGood") }}</dt>
                        <dd>
                            <Datetime v-if="evidence.lastGood" :value="evidence.lastGood.time" />
                            <span v-else>{{ $t("stage2NotInHistory") }}</span>
                        </dd>
                    </div>
                    <div v-if="evidence.firstObserved">
                        <dt>{{ $t("stage2FirstEvidence") }}</dt>
                        <dd><Datetime :value="evidence.firstObserved.time" /></dd>
                    </div>
                    <div v-if="evidence.firstConfirmed">
                        <dt>{{ $t("stage2ConfirmedFailure") }}</dt>
                        <dd><Datetime :value="evidence.firstConfirmed.time" /></dd>
                    </div>
                </dl>
                <p v-if="evidence.historyLimited" class="ws-channel-note">{{ $t("stage2HistoryLimited") }}</p>
                <div class="ws-check-facts">
                    <div>
                        <WorkspaceIcon name="activity" />
                        <strong>{{ $t("stage2ResponseTime") }}</strong>
                        <span>{{ measuredPing }}</span>
                        <small>
                            {{
                                monitor.max_response_time
                                    ? $t("stage2SpeedLimit", { value: monitor.max_response_time })
                                    : $t("stage2NoSpeedLimit")
                            }}
                        </small>
                    </div>
                    <div v-if="tlsInfo?.certInfo">
                        <WorkspaceIcon name="check" />
                        <strong>{{ $t("stage2SavedCertificate") }}</strong>
                        <span>
                            {{
                                $t(
                                    tlsInfo.valid && tlsInfo.hostnameMatchMonitorUrl !== false
                                        ? "stage2CertificateVerified"
                                        : "stage2CertificateIssue"
                                )
                            }}
                        </span>
                        <small><Datetime :value="tlsInfo.certInfo.validTo" date-only /></small>
                    </div>
                    <div v-if="domainInfo">
                        <WorkspaceIcon name="clock" />
                        <strong>{{ $t("stage2DomainExpiry") }}</strong>
                        <span><Datetime :value="domainInfo.expiresOn" date-only /></span>
                        <small>{{ $t("stage2SavedInformation") }}</small>
                    </div>
                </div>
                <div v-if="['down', 'unknown'].includes(evidence.state)" class="ws-incident-actions">
                    <h3>{{ $t("stage2NextSteps") }}</h3>
                    <ol>
                        <li v-for="step in steps" :key="step">{{ $t(step) }}</li>
                    </ol>
                    <p class="ws-channel-note">{{ $t("stage2GuidanceHonesty") }}</p>
                </div>
                <div class="ws-incident-buttons">
                    <router-link v-if="!projectId" :to="`/edit/${monitor.id}`" class="ws-button ws-button-quiet">
                        <WorkspaceIcon name="settings" />
                        {{ $t("stage2EditCheck") }}
                    </router-link>
                    <router-link
                        v-if="!projectId"
                        :to="`/notifications?monitor=${monitor.id}`"
                        class="ws-button ws-button-primary"
                    >
                        <WorkspaceIcon name="alerts" />
                        {{ $t("stage2AlertThisService") }}
                    </router-link>
                    <button
                        v-if="projectId && canManage"
                        type="button"
                        class="ws-button ws-button-quiet"
                        @click="$emit('edit')"
                    >
                        <WorkspaceIcon name="settings" />
                        {{ $t("stage2EditCheck") }}
                    </button>
                    <button v-if="projectId" type="button" class="ws-button ws-button-primary" @click="$emit('alerts')">
                        <WorkspaceIcon name="alerts" />
                        {{ $t("stage2AlertThisService") }}
                    </button>
                </div>
                <details class="ws-evidence-history">
                    <summary>{{ $t("stage2RecentEvidence") }}</summary>
                    <p class="ws-channel-note">{{ $t("stage2EvidenceHonesty") }}</p>
                    <ul>
                        <li v-for="(beat, index) in evidence.recent" :key="`${beat.time}-${index}`">
                            <Datetime :value="beat.time" />
                            <span>
                                {{
                                    $t(
                                        beat.workLabel ||
                                            (beat.status === 1
                                                ? "workspaceStateWorking"
                                                : beat.status === 0
                                                  ? "workspaceStateDown"
                                                  : beat.status === 2
                                                    ? "workspaceStatePending"
                                                    : "workspaceStateMaintenance")
                                    )
                                }}
                            </span>
                        </li>
                    </ul>
                </details>
            </div>
            <IncidentAI
                :key="`${projectId || 'personal'}-${monitor.id}`"
                :monitor-id="monitor.id"
                :project-id="projectId"
            />
        </div>
        <DeliveryHistory v-if="!projectId" :monitor-id="monitor.id" compact />
    </section>
</template>

<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
import Datetime from "./Datetime.vue";
import DeliveryHistory from "./DeliveryHistory.vue";
import ObservationChart from "./ObservationChart.vue";
import IncidentAI from "./IncidentAI.vue";
import { incidentEvidence, incidentActions } from "../incident-state.ts";
import { workFromBeat, validatedWork } from "../site-work.ts";
export default {
    components: { WorkspaceIcon, Datetime, DeliveryHistory, ObservationChart, IncidentAI },
    props: {
        monitor: { type: Object, required: true },
        tlsInfo: { type: Object, default: null },
        domainInfo: { type: Object, default: null },
        observations: { type: Array, default: null },
        projectId: { type: Number, default: null },
        canManage: { type: Boolean, default: true },
    },
    emits: ["edit", "alerts"],
    data() {
        return {
            now: Date.now(),
            clock: null,
            labels: {
                up: "workspaceStateWorking",
                down: "workspaceStateDown",
                pending: "workspaceStatePending",
                unknown: "workspaceStateUnknown",
                paused: "workspaceStatePaused",
                maintenance: "workspaceStateMaintenance",
            },
            titles: {
                up: "stage2HealthyTitle",
                down: "stage2FailureTitle",
                pending: "stage2PendingTitle",
                unknown: "stage2UnknownTitle",
                paused: "stage2PausedTitle",
                maintenance: "stage2MaintenanceTitle",
            },
            icons: {
                up: "check",
                down: "warning",
                pending: "clock",
                unknown: "unknown",
                paused: "pause",
                maintenance: "settings",
            },
        };
    },
    computed: {
        savedObservations() {
            return this.observations || this.$root.heartbeatList[this.monitor.id] || [];
        },
        evidence() {
            return incidentEvidence(this.monitor, this.savedObservations, this.now, this.$root.socket.connected);
        },
        savedWork() {
            const work = this.evidence.state === "maintenance" ? workFromBeat(this.evidence.latest) : null;
            return work && this.now < work.deadline ? work : null;
        },
        liveWork() {
            const source = this.monitor.siteWork;
            return this.$root.socket.connected &&
                source &&
                ["active", "overdue"].includes(source.state) &&
                this.now - source.observedAt <= 45000 &&
                source.observedAt <= this.now + 5000
                ? validatedWork(source.work)
                : null;
        },
        shownWork() {
            return this.evidence.state === "paused" ? null : this.liveWork || this.savedWork;
        },
        workOverdue() {
            return this.shownWork && this.now >= this.shownWork.deadline;
        },
        steps() {
            return incidentActions(this.evidence.explanation);
        },
        measuredPing() {
            const ping = this.evidence.latest?.ping;
            return typeof ping === "number" && Number.isFinite(ping) && ping >= 0
                ? this.$t("workspaceMilliseconds", {
                      value: new Intl.NumberFormat(this.$i18n.locale, { maximumFractionDigits: 1 }).format(ping),
                  })
                : "—";
        },
    },
    mounted() {
        this.clock = setInterval(() => {
            this.now = Date.now();
        }, 10000);
    },
    beforeUnmount() {
        clearInterval(this.clock);
    },
};
</script>
