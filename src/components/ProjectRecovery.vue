<template>
    <section class="ws-project-panel ws-recovery" data-testid="project-recovery">
        <div class="ws-heading-row">
            <div>
                <p class="ws-eyebrow">{{ $t("projectRecoveryOwnerControl") }}</p>
                <h2>{{ $t("projectRecoveryTitle") }}</h2>
                <p class="ws-subtitle">{{ $t("projectRecoveryIntro") }}</p>
            </div>
            <span class="ws-project-badge">{{ $t("projectRecoveryManualOnly") }}</span>
        </div>
        <p v-if="error && !confirmation" role="alert" class="ws-form-error">{{ $t(error) }}</p>
        <p v-if="state.configurationError" role="status">{{ $t("projectRecoveryPolicy") }}</p>
        <p v-if="loaded && !state.configured" class="ws-channel-note">{{ $t("projectRecoverySetupHelp") }}</p>
        <p v-if="state.configured && !state.executorReady" role="status">{{ $t("projectRecoveryExecutor") }}</p>
        <label v-if="targets.length" class="ws-project-picker">
            {{ $t("projectRecoveryApplication") }}
            <select v-model="targetID" class="form-select">
                <option v-for="item in targets" :key="item.id" :value="item.id">{{ item.title }}</option>
            </select>
        </label>
        <div v-if="target" class="ws-recovery-workflow">
            <ol class="ws-recovery-steps" :aria-label="$t('projectRecoverySteps')">
                <li>
                    <span>1</span>
                    {{ $t("projectRecoveryStepPlan") }}
                </li>
                <li>
                    <span>2</span>
                    {{ $t("projectRecoveryStepConfirm") }}
                </li>
                <li>
                    <span>3</span>
                    {{ $t("projectRecoveryStepApply") }}
                </li>
                <li>
                    <span>4</span>
                    {{ $t("projectRecoveryStepVerify") }}
                </li>
            </ol>
            <p>{{ $t("projectRecoveryScenario") }}</p>
            <p class="ws-channel-note">{{ $t("projectRecoveryRisks") }}</p>
            <p v-if="!isOwner" class="ws-channel-note">{{ $t("projectRecoveryOwnerOnly") }}</p>
            <div v-if="canPropose" class="ws-wizard-buttons">
                <button
                    v-if="!preview"
                    class="ws-button ws-button-primary"
                    :disabled="busy || pendingAI || aiState !== 'verified'"
                    @click="prepare"
                >
                    {{ $t("projectRecoveryReviewData") }}
                </button>
                <p v-if="aiState !== 'verified'" class="ws-channel-note">{{ $t("projectAINeedProbe") }}</p>
            </div>
            <div v-if="preview && canPropose" class="ws-recovery-preview" data-testid="recovery-evidence">
                <h3>{{ $t("projectAIExactData") }}</h3>
                <details class="ws-evidence-history">
                    <summary>{{ $t("projectRecoveryShowData") }}</summary>
                    <pre>{{ JSON.stringify(preview.evidence, null, 2) }}</pre>
                </details>
                <p>{{ $t("projectRecoveryAIConsent") }}</p>
                <div class="ws-wizard-buttons">
                    <button class="ws-button ws-button-primary" :disabled="busy || pendingAI" @click="askAI">
                        {{ $t("projectRecoveryAskAI") }}
                    </button>
                    <button class="ws-button ws-button-quiet" :disabled="busy" @click="preview = null">
                        {{ $t("Cancel") }}
                    </button>
                </div>
            </div>
            <article v-if="proposal" class="ws-recovery-proposal" data-testid="recovery-proposal">
                <div class="ws-heading-row">
                    <h3>{{ $t("projectRecoveryAIProposal") }}</h3>
                    <span>{{ $t(`projectAIJob_${proposal.status}`) }}</span>
                </div>
                <p v-if="proposal.errorCode">{{ $t(`projectAIError_${proposal.errorCode}`) }}</p>
                <template v-if="proposal.result">
                    <ul>
                        <li v-for="(fact, index) in proposal.result.facts" :key="index">{{ fact }}</li>
                    </ul>
                    <p>{{ proposal.result.remediation?.reason }}</p>
                    <p v-if="proposal.result.remediation?.action !== 'restore_config'" class="ws-channel-note">
                        {{ $t("projectRecoveryNoRecommendation") }}
                    </p>
                    <button
                        v-if="canPropose && proposal.result.remediation?.action === 'restore_config' && !currentJob"
                        class="ws-button ws-button-primary"
                        :disabled="busy"
                        @click="makePlan"
                    >
                        {{ $t("projectRecoveryMakePlan") }}
                    </button>
                </template>
                <p v-if="proposal.usage" class="ws-channel-note">
                    {{
                        $t("projectAITokenUsage", {
                            input: proposal.usage.input_tokens ?? "—",
                            output: proposal.usage.output_tokens ?? "—",
                        })
                    }}
                    · {{ $t("projectAICostUnknown") }}
                </p>
            </article>
        </div>
        <h3 v-if="jobs.length">{{ $t("projectRecoveryHistory") }}</h3>
        <article v-for="job in jobs" :key="job.id" class="ws-recovery-job" :data-testid="`recovery-job-${job.id}`">
            <RecoveryProgress :job="job" />
            <div class="ws-heading-row">
                <div>
                    <strong>{{ job.title }}</strong>
                    <p class="ws-channel-note">{{ formatTime(job.createdAt) }}</p>
                </div>
                <span class="ws-project-badge" role="status">{{ $t(`projectRecoveryStatus_${job.status}`) }}</span>
            </div>
            <p v-if="job.errorCode">{{ $t(job.errorCode) }}</p>
            <template v-if="job.status === 'planned'">
                <p>{{ $t("projectRecoveryPlanHelp") }}</p>
                <ul>
                    <li>{{ $t("projectRecoverySnapshotFirst") }}</li>
                    <li>{{ $t("projectRecoveryReplaceOne") }}</li>
                    <li v-if="job.reload === 'systemd'">{{ $t("projectRecoveryRestartOne") }}</li>
                    <li>{{ $t("projectRecoveryVerifyTwo") }}</li>
                    <li>{{ $t("projectRecoveryRollbackOnFailure") }}</li>
                </ul>
                <p class="ws-channel-note">{{ $t("projectRecoveryExpires", { time: formatTime(job.expiresAt) }) }}</p>
            </template>
            <p v-if="job.snapshotAt" class="ws-channel-note">
                {{ $t("projectRecoverySnapshotSaved", { time: formatTime(job.snapshotAt) }) }}
            </p>
            <p v-if="job.status === 'verifying'" role="status">{{ $t("projectRecoveryWaiting") }}</p>
            <div
                v-if="job.verification || job.rollbackVerification"
                class="ws-recovery-observations"
                :class="{
                    'ws-recovery-observations-unhealthy': job.rollbackVerification && !job.rollbackVerification.healthy,
                }"
            >
                <p v-if="job.verification">
                    {{ $t("projectRecoveryVerified", { count: job.verification.observations.length }) }}
                </p>
                <p v-if="job.rollbackVerification">
                    {{
                        $t(
                            job.rollbackVerification.healthy
                                ? "projectRecoveryRollbackHealthy"
                                : "projectRecoveryRollbackUnhealthy"
                        )
                    }}
                </p>
                <ol>
                    <li v-for="beat in (job.rollbackVerification || job.verification).observations" :key="beat.id">
                        {{ beat.time }} UTC ·
                        {{
                            $t(
                                beat.status === 1
                                    ? "projectCurrent_up"
                                    : beat.status === 0
                                      ? "projectCurrent_down"
                                      : "projectCurrent_unknown"
                            )
                        }}
                    </li>
                </ol>
            </div>
            <details class="ws-evidence-history">
                <summary>{{ $t("projectRecoveryTechnical") }}</summary>
                <p>
                    {{ $t("projectRecoveryBefore") }}
                    <code>{{ job.beforeHash }}</code>
                </p>
                <p>
                    {{ $t("projectRecoveryAfter") }}
                    <code>{{ job.afterHash }}</code>
                </p>
            </details>
            <div v-if="isOwner" class="ws-wizard-buttons">
                <button
                    v-if="job.status === 'planned'"
                    class="ws-button ws-button-primary"
                    :disabled="busy || !state.executorReady"
                    @click="confirm('approve', job)"
                >
                    {{ $t("projectRecoveryReviewApproval") }}
                </button>
                <button
                    v-if="job.canRollback"
                    class="ws-button ws-button-quiet"
                    :disabled="busy || !state.executorReady"
                    @click="confirm('rollback', job)"
                >
                    {{ $t("projectRecoveryReturn") }}
                </button>
                <button
                    v-if="['planned', 'queued', 'preparing', 'applying', 'verifying'].includes(job.status)"
                    class="ws-button ws-button-quiet"
                    :disabled="busy || job.cancelRequested"
                    @click="cancel(job)"
                >
                    {{ $t("Cancel") }}
                </button>
            </div>
        </article>
        <div v-for="item in state.breakers || []" :key="item.target_id" class="ws-recovery-breaker">
            <p>{{ $t("projectRecoveryBlocked") }}</p>
            <button v-if="isOwner" class="ws-button ws-button-quiet" :disabled="busy" @click="confirm('reset', item)">
                {{ $t("projectRecoveryAllowRetry") }}
            </button>
        </div>
        <form
            v-if="confirmation && isOwner"
            ref="decisionForm"
            class="ws-alert-wizard ws-recovery-confirm"
            data-testid="recovery-confirmation"
            @submit.prevent="submit"
        >
            <h3>
                {{
                    $t(
                        confirmation.operation === "approve"
                            ? "projectRecoveryReviewApproval"
                            : confirmation.operation === "rollback"
                              ? "projectRecoveryReturn"
                              : "projectRecoveryAllowRetry"
                    )
                }}
            </h3>
            <p>
                {{ $t("projectRecoveryApplication") }}:
                <strong>{{ confirmation.title }}</strong>
            </p>
            <ul v-if="confirmation.operation === 'approve'">
                <li>{{ $t("projectRecoverySnapshotFirst") }}</li>
                <li>{{ $t("projectRecoveryReplaceOne") }}</li>
                <li v-if="confirmation.reload === 'systemd'">{{ $t("projectRecoveryRestartOne") }}</li>
                <li>{{ $t("projectRecoveryVerifyTwo") }}</li>
                <li>{{ $t("projectRecoveryRollbackOnFailure") }}</li>
            </ul>
            <p>{{ $t("projectRecoveryOwnerConsentHelp") }}</p>
            <p v-if="error" role="alert" class="ws-form-error">{{ $t(error) }}</p>
            <label class="ws-wizard-checkbox">
                <input v-model="consent" type="checkbox" required />
                {{
                    $t(
                        confirmation.operation === "approve"
                            ? "projectRecoveryConsent"
                            : confirmation.operation === "rollback"
                              ? "projectRecoveryReturnConsent"
                              : "projectRecoveryRetryConsent"
                    )
                }}
            </label>
            <label>
                {{ $t("Current Password") }}
                <input
                    v-model="password"
                    type="password"
                    class="form-control"
                    autocomplete="current-password"
                    required
                    maxlength="1024"
                />
            </label>
            <div class="ws-wizard-buttons">
                <button class="ws-button ws-button-primary" type="submit" :disabled="busy || !consent || !password">
                    {{ $t("projectRecoveryConfirm") }}
                </button>
                <button class="ws-button ws-button-quiet" type="button" :disabled="busy" @click="clearConfirmation">
                    {{ $t("Cancel") }}
                </button>
            </div>
        </form>
    </section>
</template>
<script>
import { projectRequest } from "../project-workflow";
import RecoveryProgress from "./RecoveryProgress.vue";
export default {
    components: { RecoveryProgress },
    props: {
        projectId: { type: Number, required: true },
        role: { type: String, required: true },
        aiState: { type: String, default: "off" },
    },
    data() {
        return {
            state: {},
            aiJobs: [],
            targetID: "",
            loaded: false,
            busy: false,
            refreshing: false,
            error: "",
            preview: null,
            confirmation: null,
            password: "",
            consent: false,
            generation: 0,
            clock: null,
        };
    },
    computed: {
        targets() {
            return this.state.targets || [];
        },
        target() {
            return this.targets.find((item) => item.id === this.targetID) || null;
        },
        jobs() {
            return (this.state.jobs || []).filter((item) => !this.target || item.targetID === this.target.id);
        },
        currentJob() {
            return this.jobs.find((item) => item.aiJobID === this.proposal?.id);
        },
        proposal() {
            return (
                this.aiJobs.find((item) => item.kind === "recovery" && item.recoveryTargetID === this.targetID) || null
            );
        },
        isOwner() {
            return this.state.isOwner === true;
        },
        canPropose() {
            return ["admin", "operator"].includes(this.role);
        },
        pendingAI() {
            return this.aiJobs.some((item) => ["queued", "running"].includes(item.status));
        },
    },
    watch: {
        role() {
            this.generation++;
            this.state = {};
            this.aiJobs = [];
            this.preview = null;
            this.busy = false;
            this.refreshing = false;
            this.clearConfirmation();
            this.load();
        },
        targetID() {
            this.preview = null;
            this.clearConfirmation();
        },
    },
    mounted() {
        this.load();
        this.clock = setInterval(() => this.load(), 2500);
    },
    beforeUnmount() {
        this.generation++;
        clearInterval(this.clock);
        this.clearConfirmation();
    },
    methods: {
        /**
         * @returns {Promise<void>} Only local state is polled; no model request
         */
        async load() {
            if (this.refreshing || this.busy || !this.$root.socket.connected) {
                return;
            }
            const generation = this.generation;
            this.refreshing = true;
            try {
                const state = await projectRequest(this.$root, "projectRecoveryGet", { projectID: this.projectId });
                const ai = await projectRequest(this.$root, "projectAIJobs", { projectID: this.projectId });
                if (generation !== this.generation) {
                    return;
                }
                this.state = state;
                this.aiJobs = ai.jobs;
                if (this.confirmation && this.confirmation.operation !== "reset") {
                    const reviewed = state.jobs.find((item) => item.id === this.confirmation.id);
                    if (!reviewed || reviewed.revision !== this.confirmation.revision) {
                        this.clearConfirmation();
                        this.error = "projectRecoveryStale";
                    }
                }
                if (!this.targetID || !state.targets.some((item) => item.id === this.targetID)) {
                    this.targetID = state.targets[0]?.id || "";
                }
                this.loaded = true;
                if (!state.isOwner) {
                    this.clearConfirmation();
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                    this.state = {};
                    this.aiJobs = [];
                    this.clearConfirmation();
                }
            } finally {
                if (generation === this.generation) {
                    this.refreshing = false;
                }
            }
        },
        /**
         * @param {string} event Closed action
         * @param {object} request Scope
         * @returns {Promise<object|null>} Guarded result
         */
        async action(event, request) {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                const result = await projectRequest(this.$root, event, { ...request, projectID: this.projectId });
                return generation === this.generation ? result : null;
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
                return null;
            } finally {
                if (generation === this.generation) {
                    this.busy = false;
                }
            }
        },
        /**
         * @returns {Promise<void>} Show exact safe input first
         */
        async prepare() {
            const result = await this.action("projectAIPrepare", {
                kind: "recovery",
                targetID: this.target.id,
                monitorID: this.target.monitorID,
            });
            if (result) {
                this.preview = result;
            }
        },
        /**
         * @returns {Promise<void>} Explicitly request a proposal without executing
         */
        async askAI() {
            const result = await this.action("projectAIEnqueue", {
                kind: "recovery",
                targetID: this.target.id,
                monitorID: this.target.monitorID,
                evidenceHash: this.preview.hash,
                revision: this.preview.revision,
            });
            if (result) {
                this.preview = null;
                await this.load();
            } else if (this.error === "projectAIEvidenceChanged") {
                this.preview = null;
            }
        },
        /**
         * @returns {Promise<void>} Freeze a concrete plan for owner review
         */
        async makePlan() {
            if (await this.action("projectRecoveryPlan", { aiJobID: this.proposal.id })) {
                await this.load();
            }
        },
        /**
         * @param {string} operation Decision
         * @param {object} job Exact reviewed state
         * @returns {void} Open reauthentication
         */
        confirm(operation, job) {
            this.clearConfirmation();
            this.confirmation = {
                operation,
                id: job.id,
                revision: job.revision,
                planHash: job.planHash,
                targetID: job.target_id,
                title: job.title || this.targets.find((item) => item.id === job.target_id)?.title || "",
                reload: job.reload,
            };
            this.$nextTick(() => {
                const form = this.$refs.decisionForm;
                form?.scrollIntoView({
                    block: "center",
                    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                });
                form?.querySelector("input[type=password]")?.focus({ preventScroll: true });
            });
        },
        /**
         * @returns {void} Forget password and decision
         */
        clearConfirmation() {
            this.confirmation = null;
            this.password = "";
            this.consent = false;
        },
        /**
         * @returns {Promise<void>} Approve only the captured plan and rollback contract
         */
        async submit() {
            const confirmation = this.confirmation;
            const events = {
                approve: "projectRecoveryApprove",
                rollback: "projectRecoveryRollback",
                reset: "projectRecoveryReset",
            };
            const password = this.password;
            this.password = "";
            const result = await this.action(events[confirmation.operation], {
                ...confirmation,
                password,
                confirm: this.consent,
            });
            if (result) {
                this.clearConfirmation();
                await this.load();
            }
        },
        /**
         * @param {object} job Scoped action
         * @returns {Promise<void>} Cancel; applied changes are compensated
         */
        async cancel(job) {
            if (await this.action("projectRecoveryCancel", { id: job.id, revision: job.revision })) {
                await this.load();
            }
        },
        /**
         * @param {number} time Epoch
         * @returns {string} Local display
         */
        formatTime(time) {
            return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: "short", timeStyle: "short" }).format(
                new Date(time)
            );
        },
    },
};
</script>
