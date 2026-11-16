<template>
    <section class="ws-project-panel ws-code-recovery" data-testid="project-code-recovery">
        <div class="ws-heading-row">
            <div>
                <p class="ws-eyebrow">{{ $t("codeRecoveryEyebrow") }}</p>
                <h2>{{ $t("codeRecoveryTitle") }}</h2>
                <p class="ws-subtitle">{{ $t("codeRecoveryIntro") }}</p>
            </div>
            <span class="ws-project-badge">{{ $t("projectRecoveryManualOnly") }}</span>
        </div>
        <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
        <p v-if="!state.isOwner" class="ws-channel-note">{{ $t("projectRecoveryOwnerOnly") }}</p>
        <p v-if="state.configurationError" role="status">{{ $t("projectCodeRecoveryPolicy") }}</p>
        <template v-if="state.isOwner && state.targets?.length">
            <label class="ws-project-picker">
                {{ $t("projectRecoveryApplication") }}
                <select v-model="targetID" class="form-select" :disabled="busy">
                    <option v-for="entry in state.targets" :key="entry.id" :value="entry.id">
                        {{ entry.title }}
                    </option>
                </select>
            </label>
            <ol class="ws-recovery-steps" :aria-label="$t('projectRecoverySteps')">
                <li>
                    <span>1</span>
                    {{ $t("codeRecoveryStepSource") }}
                </li>
                <li>
                    <span>2</span>
                    {{ $t("codeRecoveryStepTest") }}
                </li>
                <li>
                    <span>3</span>
                    {{ $t("projectRecoveryStepConfirm") }}
                </li>
                <li>
                    <span>4</span>
                    {{ $t("projectRecoveryStepVerify") }}
                </li>
            </ol>
            <p v-if="fileIndex?.updatesDeferred" class="ws-code-notice" role="status">
                {{ $t("codeRecoveryDeferred") }}
            </p>
            <form v-if="!pending" class="ws-code-form" @submit.prevent="prepare">
                <label>
                    {{ $t("codeRecoveryProblem") }}
                    <textarea
                        v-model="description"
                        class="form-control"
                        rows="3"
                        minlength="15"
                        maxlength="3000"
                        required
                        :placeholder="$t('codeRecoveryProblemPlaceholder')"
                    ></textarea>
                </label>
                <p class="ws-channel-note">{{ $t("codeRecoveryLimits") }}</p>
                <button
                    v-if="!fileIndex"
                    class="ws-button ws-button-secondary"
                    type="button"
                    :disabled="busy || !targetID"
                    @click="loadIndex"
                >
                    {{ $t("codeRecoveryChooseFiles") }}
                </button>
                <fieldset v-if="fileIndex" class="ws-code-files">
                    <legend>{{ $t("codeRecoveryFiles") }}</legend>
                    <p class="ws-channel-note">{{ $t("codeRecoveryFilesHelp") }}</p>
                    <input
                        v-model="search"
                        class="form-control"
                        type="search"
                        :aria-label="$t('codeRecoveryFindFile')"
                        :placeholder="$t('codeRecoveryFindFile')"
                    />
                    <div class="ws-code-file-list">
                        <label v-for="file in filteredFiles" :key="file.path">
                            <input
                                v-model="selectedPaths"
                                type="checkbox"
                                :value="file.path"
                                :disabled="busy || (selectedPaths.length >= 4 && !selectedPaths.includes(file.path))"
                            />
                            <code>{{ file.path }}</code>
                            <small>{{ Math.ceil(file.bytes / 1024) }} {{ $t("codeRecoveryKB") }}</small>
                        </label>
                    </div>
                    <label v-for="path in selectedPaths" :key="path" class="ws-code-window">
                        {{ path }} · {{ $t("codeRecoveryOffset") }}
                        <input
                            v-model.number="offsets[path]"
                            class="form-control"
                            type="number"
                            min="0"
                            max="4194304"
                            step="1"
                        />
                    </label>
                </fieldset>
                <button
                    v-if="fileIndex"
                    class="ws-button ws-button-primary"
                    type="submit"
                    :disabled="busy || !selectedPaths.length || aiState !== 'verified'"
                >
                    {{ $t("codeRecoveryPreview") }}
                </button>
            </form>
            <div v-if="preview" class="ws-recovery-preview" data-testid="code-source-preview">
                <h3>{{ $t("projectAIExactData") }}</h3>
                <p>{{ $t("codeRecoveryConnection", { model: preview.evidence.connection.model }) }}</p>
                <p>{{ $t("codeRecoveryConsentHelp") }}</p>
                <details>
                    <summary>{{ $t("projectRecoveryShowData") }}</summary>
                    <pre>{{ JSON.stringify(preview.evidence, null, 2) }}</pre>
                </details>
                <label class="ws-checkbox">
                    <input v-model="sourceConsent" type="checkbox" />
                    {{ $t("codeRecoverySourceConsent") }}
                </label>
                <div class="ws-wizard-buttons">
                    <button class="ws-button ws-button-primary" :disabled="busy || !sourceConsent" @click="generate">
                        {{ $t("codeRecoveryGenerate") }}
                    </button>
                    <button class="ws-button ws-button-quiet" :disabled="busy" @click="clearPreview">
                        {{ $t("Cancel") }}
                    </button>
                </div>
            </div>
        </template>
        <article v-for="job in jobs" :key="job.id" class="ws-recovery-job" :data-testid="`code-job-${job.id}`">
            <div class="ws-heading-row">
                <div>
                    <strong>{{ $t("codeRecoveryPlanNumber", { id: job.id }) }}</strong>
                    <p class="ws-channel-note">{{ time(job.createdAt) }}</p>
                </div>
                <span class="ws-project-badge" role="status" :class="{ 'ws-code-pending': isWorking(job.status) }">
                    {{ $t(`codeRecoveryStatus_${job.status}`) }}
                </span>
            </div>
            <p v-if="job.errorCode" role="status">{{ $t(job.errorCode) }}</p>
            <p v-if="job.backup" class="ws-channel-note">{{ $t("codeRecoveryBackupSaved") }}</p>
            <p v-if="job.verification">
                {{ $t(job.verification.healthy ? "codeRecoveryVerified" : "projectRecoveryNoObservations") }}
            </p>
            <p v-if="job.rollback">
                {{ $t(job.rollback.healthy ? "codeRecoveryRollbackVerified" : "codeRecoveryRollbackUnhealthy") }}
            </p>
            <div v-if="state.isOwner" class="ws-wizard-buttons">
                <button class="ws-button ws-button-secondary" :disabled="busy" @click="inspect(job)">
                    {{ $t("codeRecoveryDetails") }}
                </button>
                <button v-if="job.plan" class="ws-button ws-button-quiet" :disabled="busy" @click="download(job)">
                    {{ $t("codeRecoveryExport") }}
                </button>
                <button
                    v-if="job.status === 'planned'"
                    class="ws-button ws-button-primary"
                    :disabled="busy"
                    @click="confirm(job, 'Approve')"
                >
                    {{ $t("codeRecoveryReviewInstall") }}
                </button>
                <button
                    v-if="isWorking(job.status) || job.status === 'planned'"
                    class="ws-button ws-button-quiet"
                    :disabled="busy || job.cancelRequested"
                    @click="cancel(job)"
                >
                    {{ $t("Cancel") }}
                </button>
                <button
                    v-if="job.canRollback"
                    class="ws-button ws-button-secondary"
                    :disabled="busy"
                    @click="confirm(job, 'Rollback')"
                >
                    {{ $t("codeRecoveryReturn") }}
                </button>
            </div>
            <div v-if="details?.job.id === job.id" class="ws-code-details" data-testid="code-plan-details">
                <p v-if="details.proposal">{{ details.proposal.remediation.reason }}</p>
                <p v-if="job.plan?.qualification">
                    {{ $t("codeRecoveryTestResults", { count: job.plan.qualification.tests }) }}
                </p>
                <p v-if="job.plan?.checks">{{ $t("codeRecoveryAllChecks", { count: job.plan.checks.length }) }}</p>
                <p v-if="details.review">{{ details.review.summary }}</p>
                <ul v-if="details.review?.findings.length">
                    <li v-for="(finding, i) in details.review.findings" :key="i">
                        {{ finding.path }}: {{ finding.reason }}
                    </li>
                </ul>
                <p v-for="(limit, i) in details.review?.limitations || []" :key="i" class="ws-channel-note">
                    {{ limit }}
                </p>
                <p v-if="job.plan" class="ws-channel-note">
                    {{ $t("codeRecoveryVersion") }}:
                    <code>{{ job.plan.sourceVersion }}</code>
                </p>
                <div
                    v-for="change in details.proposal?.remediation.changes || []"
                    :key="change.path"
                    class="ws-code-change"
                >
                    <h4>{{ change.path }}</h4>
                    <div v-for="(edit, i) in change.edits" :key="i" class="ws-code-diff">
                        <div>
                            <strong>{{ $t("codeRecoveryBefore") }}</strong>
                            <pre class="ws-code-before">{{ edit.before }}</pre>
                        </div>
                        <div>
                            <strong>{{ $t("codeRecoveryAfter") }}</strong>
                            <pre class="ws-code-after">{{ edit.after }}</pre>
                        </div>
                    </div>
                </div>
                <details v-if="details.proposal?.remediation.test.code">
                    <summary>{{ $t("codeRecoveryRegression") }}</summary>
                    <pre>{{ details.proposal.remediation.test.code }}</pre>
                </details>
                <details
                    v-if="
                        job.plan?.changes.some(
                            (change) => change.cacheReferences?.length || change.compressionRemoved?.length
                        )
                    "
                >
                    <summary>{{ $t("codeRecoveryAutomaticChanges") }}</summary>
                    <template v-for="change in job.plan.changes" :key="change.path">
                        <p v-if="change.cacheReferences?.length">
                            <code>{{ change.path }}</code>
                        </p>
                        <p v-for="(ref, i) in change.cacheReferences || []" :key="i">
                            <code>{{ ref.before }}</code>
                            →
                            <code>{{ ref.after }}</code>
                        </p>
                        <p v-for="file in change.compressionRemoved || []" :key="file">
                            {{ $t("codeRecoveryCompressionRemoved") }}:
                            <code>{{ file }}</code>
                        </p>
                    </template>
                </details>
            </div>
        </article>
        <form
            v-if="confirmation"
            class="ws-recovery-confirmation ws-code-notice"
            data-testid="code-owner-confirm"
            @submit.prevent="submitConfirmation"
        >
            <h3>
                {{
                    $t(
                        confirmation.operation === "Rollback"
                            ? "codeRecoveryReturn"
                            : confirmation.operation === "Reset"
                              ? "codeRecoveryReset"
                              : "codeRecoveryInstall"
                    )
                }}
            </h3>
            <p>
                {{
                    $t(
                        confirmation.operation === "Rollback"
                            ? "codeRecoveryRollbackHelp"
                            : confirmation.operation === "Reset"
                              ? "codeRecoveryResetHelp"
                              : "codeRecoveryApprovalHelp"
                    )
                }}
            </p>
            <p>{{ $t("codeRecoveryDeferred") }}</p>
            <p class="ws-channel-note">{{ $t("codeRecoveryRollbackLimits") }}</p>
            <label class="ws-checkbox">
                <input v-model="consent" type="checkbox" required />
                {{ $t("codeRecoveryApproveExact") }}
            </label>
            <label>
                {{ $t("Current Password") }}
                <input
                    v-model="password"
                    type="password"
                    class="form-control"
                    autocomplete="current-password"
                    maxlength="1024"
                    required
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
        <div v-if="state.isOwner && state.breakers?.some((b) => b.target_id === targetID)" class="ws-code-notice">
            <p>{{ $t("projectRecoveryBlocked") }}</p>
            <button class="ws-button ws-button-secondary" :disabled="busy" @click="confirm({ targetID }, 'Reset')">
                {{ $t("codeRecoveryReset") }}
            </button>
        </div>
    </section>
</template>
<script>
import { projectRequest } from "../project-workflow";
export default {
    props: {
        projectId: { type: Number, required: true },
        role: { type: String, required: true },
        aiState: { type: String, default: "off" },
        selectedMonitor: { type: Object, default: null },
    },
    data() {
        return {
            state: {},
            targetID: "",
            busy: false,
            refreshing: false,
            error: "",
            description: "",
            fileIndex: null,
            selectedPaths: [],
            offsets: {},
            search: "",
            preview: null,
            sourceConsent: false,
            details: null,
            confirmation: null,
            password: "",
            consent: false,
            generation: 0,
            timer: null,
        };
    },
    computed: {
        jobs() {
            return (this.state.jobs || []).filter((j) => j.targetID === this.targetID);
        },
        pending() {
            return this.jobs.some((j) => this.isWorking(j.status) || j.status === "planned");
        },
        filteredFiles() {
            return (this.fileIndex?.files || [])
                .filter((f) => f.path.toLowerCase().includes(this.search.toLowerCase()))
                .slice(0, 100);
        },
    },
    watch: {
        targetID() {
            this.generation++;
            this.busy = false;
            this.fileIndex = null;
            this.selectedPaths = [];
            this.offsets = {};
            this.details = null;
            this.clearPreview();
            this.clearConfirmation();
        },
        role() {
            this.generation++;
            this.busy = false;
            this.refreshing = false;
            this.state = {};
            this.details = null;
            this.clearPreview();
            this.clearConfirmation();
            this.load();
        },
        projectId() {
            this.generation++;
            this.busy = false;
            this.refreshing = false;
            this.state = {};
            this.details = null;
            this.clearPreview();
            this.clearConfirmation();
            this.load();
        },
    },
    mounted() {
        this.load();
        this.timer = setInterval(() => this.load(), 2500);
    },
    beforeUnmount() {
        this.generation++;
        clearInterval(this.timer);
        this.clearPreview();
        this.clearConfirmation();
        this.details = null;
    },
    methods: {
        isWorking(status) {
            return [
                "generating",
                "staging",
                "reviewing",
                "queued",
                "backing_up",
                "applying",
                "verifying",
                "rollback_queued",
                "rolling_back",
                "verifying_rollback",
            ].includes(status);
        },
        time(value) {
            return new Date(value).toLocaleString();
        },
        async request(action, data = {}) {
            return projectRequest(this.$root, "projectCodeRecovery" + action, { projectID: this.projectId, ...data });
        },
        target() {
            const target = this.state.targets?.find((t) => t.id === this.targetID);
            return { targetID: target?.id, monitorID: target?.monitorID };
        },
        async act(action) {
            if (this.busy) return;
            this.busy = true;
            this.error = "";
            const generation = this.generation;
            try {
                await action(generation);
            } catch (error) {
                if (generation === this.generation) this.error = error.message;
            } finally {
                if (generation === this.generation) this.busy = false;
            }
        },
        async load() {
            if (this.busy || this.refreshing || !this.$root.socket.connected) return;
            this.refreshing = true;
            const generation = this.generation;
            try {
                const state = await this.request("Get");
                if (generation !== this.generation) return;
                this.state = state;
                if (!state.targets?.some((t) => t.id === this.targetID))
                    this.targetID =
                        state.targets?.find((t) => t.monitorID === this.selectedMonitor?.id)?.id ||
                        state.targets?.[0]?.id ||
                        "";
                if (!state.isOwner) {
                    this.details = null;
                    this.clearPreview();
                    this.clearConfirmation();
                }
                if (
                    this.confirmation?.id &&
                    !state.jobs.some((j) => j.id === this.confirmation.id && j.revision === this.confirmation.revision)
                ) {
                    this.clearConfirmation();
                    this.error = "projectRecoveryStale";
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                    this.state = {};
                    this.details = null;
                    this.clearPreview();
                    this.clearConfirmation();
                }
            } finally {
                this.refreshing = false;
            }
        },
        loadIndex() {
            return this.act(async (generation) => {
                const result = await this.request("Index", this.target());
                if (generation === this.generation) this.fileIndex = result.index;
            });
        },
        prepare() {
            return this.act(async (generation) => {
                const result = await this.request("Preview", {
                    ...this.target(),
                    description: this.description,
                    paths: this.selectedPaths.map((path) => ({ path, offset: this.offsets[path] || 0 })),
                });
                if (generation === this.generation) {
                    this.preview = result;
                    this.sourceConsent = false;
                }
            });
        },
        async generate() {
            await this.act(async () => {
                await this.request("Generate", {
                    token: this.preview.token,
                    hash: this.preview.hash,
                    confirm: this.sourceConsent,
                });
                this.clearPreview();
            });
            await this.load();
        },
        clearPreview() {
            this.preview = null;
            this.sourceConsent = false;
        },
        clearConfirmation() {
            this.confirmation = null;
            this.password = "";
            this.consent = false;
        },
        inspect(job) {
            return this.act(async (generation) => {
                const result = await this.request("Details", { id: job.id });
                if (generation === this.generation && this.state.isOwner) this.details = result;
            });
        },
        async confirm(job, operation) {
            this.clearConfirmation();
            if (operation !== "Reset") {
                await this.inspect(job);
                const current = this.state.jobs.find((j) => j.id === job.id);
                if (!current || current.revision !== job.revision || this.details?.job.revision !== job.revision) {
                    this.error = "projectRecoveryStale";
                    return;
                }
            }
            this.confirmation = { ...job, operation };
        },
        async submitConfirmation() {
            const confirmation = this.confirmation;
            await this.act(async () => {
                try {
                    await this.request(confirmation.operation, {
                        id: confirmation.id,
                        targetID: confirmation.targetID,
                        revision: confirmation.revision,
                        planHash: confirmation.planHash,
                        confirm: this.consent,
                        password: this.password,
                    });
                } finally {
                    this.clearConfirmation();
                }
            });
            await this.load();
        },
        async cancel(job) {
            await this.act(async () => {
                await this.request("Cancel", { id: job.id });
            });
            await this.load();
        },
        download(job) {
            return this.act(async () => {
                const value = await this.request("Export", { id: job.id });
                const url = URL.createObjectURL(
                    new Blob([JSON.stringify(value.package, null, 2)], { type: "application/json" })
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "site-code-fix-" + job.id + ".json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
        },
    },
};
</script>
<style scoped>
.ws-code-form,
.ws-code-files {
    display: grid;
    gap: 16px;
}

.ws-code-form > label,
.ws-code-window {
    display: grid;
    gap: 8px;
}

.ws-code-files {
    padding: 20px;
    border: 1px solid var(--workspace-border, #ced8e4);
    border-radius: 14px;
}

.ws-code-files legend {
    float: none;
    width: auto;
    font-size: 1rem;
}

.ws-code-file-list {
    max-height: 280px;
    overflow: auto;
}

.ws-code-file-list label {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 0;
}

.ws-code-file-list code {
    overflow-wrap: anywhere;
    color: inherit;
}

.ws-code-file-list small {
    margin-left: auto;
    white-space: nowrap;
}

.ws-code-window {
    grid-template-columns: minmax(0, 1fr) 100px;
    align-items: center;
    overflow-wrap: anywhere;
}

.ws-code-notice {
    padding: 20px;
    margin-block: 20px;
    border: 1px solid #b6d6d0;
    border-radius: 14px;
    background: color-mix(in srgb, #0a8b70 7%, transparent);
}

.ws-code-details {
    margin-top: 24px;
}

.ws-code-diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
}

.ws-code-change {
    margin-block: 24px;
}

.ws-code-change h4 {
    overflow-wrap: anywhere;
    font-size: 1rem;
}

.ws-code-recovery pre {
    max-height: 380px;
    padding: 16px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border-radius: 10px;
    font-size: 0.85rem;
    line-height: 1.6;
    color: inherit;
}

.ws-code-before {
    background: color-mix(in srgb, #e45865 12%, transparent);
    border: 1px solid #dd8c94;
}

.ws-code-after {
    background: color-mix(in srgb, #04a47f 12%, transparent);
    border: 1px solid #78bba8;
}

.ws-code-pending::before {
    content: "";
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 8px;
    background: #079876;
    border-radius: 50%;
    animation: code-progress 1.8s ease-in-out infinite;
}

@keyframes code-progress {
    50% {
        transform: scale(1.4);
        opacity: 0.5;
    }
}

@media (max-width: 760px) {
    .ws-code-diff {
        grid-template-columns: 1fr;
    }
}

@media (prefers-reduced-motion: reduce) {
    .ws-code-pending::before {
        animation: none;
    }
}
</style>
