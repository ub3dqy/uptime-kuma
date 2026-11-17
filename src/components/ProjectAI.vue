<template>
    <section class="ws-project-panel" data-testid="project-ai">
        <div class="ws-heading-row">
            <div v-if="!guided">
                <h2>{{ $t("projectPersonalAI") }}</h2>
                <p class="ws-subtitle">{{ $t("projectAIReadOnly") }}</p>
            </div>
            <span class="ws-project-badge">{{ $t(`projectAIState_${settings.state || "off"}`) }}</span>
        </div>
        <p v-if="guided" class="ws-channel-note">{{ $t("projectAIConnectHelp") }}</p>
        <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
        <p v-if="notice" class="ws-test-state" role="status">{{ $t(notice) }}</p>
        <p v-if="worker?.enabled" class="ws-channel-note" role="status" data-testid="project-ai-worker">
            {{ $t(worker.connected ? "projectAIWorkerConnected" : "projectAIWorkerUnavailable") }}
            <span v-if="worker.label">· {{ worker.label }}</span>
        </p>
        <p v-if="anthropicWorkerOld" class="ws-channel-note" role="status">
            {{ $t("projectAIWorkerNeedsUpdate") }}
        </p>
        <form
            v-if="canConfigure && loaded"
            class="ws-project-ai-form"
            @submit.prevent="save"
            @input="dirty = true"
            @change="dirty = true"
        >
            <div class="ws-wizard-fields">
                <label>
                    {{ $t("projectAIMode") }}
                    <select
                        v-model="form.mode"
                        class="form-select"
                        :aria-label="$t('projectAIMode')"
                        @change="chooseConnection"
                    >
                        <option value="off">{{ $t("projectAIWithout") }}</option>
                        <option value="api">{{ $t("projectAIOpenAIKey") }}</option>
                        <option value="subscription">{{ $t("projectAIChatGPTPlan") }}</option>
                        <option value="anthropic">{{ $t("projectAIAnthropic") }}</option>
                    </select>
                </label>
                <label v-if="keyMode">
                    {{ $t("projectAIKey") }}
                    <input
                        v-model="apiKey"
                        :aria-label="$t('projectAIKey')"
                        type="password"
                        class="form-control"
                        autocomplete="new-password"
                        maxlength="4096"
                        spellcheck="false"
                        name="provider-api-key"
                        :required="!sameConnection || !settings.hasSecret"
                        :placeholder="sameConnection && settings.hasSecret ? $t('stage2KeepSecret') : ''"
                    />
                    <small>{{ $t("projectAIKeyHelp") }}</small>
                </label>
                <p v-if="keyMode" class="ws-channel-note">
                    <span v-if="form.mode === 'anthropic'" class="d-block mb-1">{{ $t("projectAIClaudePlanHelp") }}</span>
                    <a
                        :href="
                            form.mode === 'anthropic'
                                ? 'https://platform.claude.com/settings/keys'
                                : 'https://platform.openai.com/api-keys'
                        "
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {{ $t(form.mode === "anthropic" ? "projectAIGetClaudeKey" : "projectAIGetOpenAIKey") }}
                    </a>
                </p>
                <label v-if="sameConnection && settings.models?.length && form.mode !== 'off'">
                    {{ $t("projectAIModel") }}
                    <select v-model="form.model" class="form-select" :aria-label="$t('projectAIModel')">
                        <option value="">{{ $t("projectAIChooseModel") }}</option>
                        <option v-for="model in settings.models || []" :key="model.id" :value="model.id">
                            {{ model.label }}
                        </option>
                    </select>
                </label>
            </div>
            <p v-if="sameConnection && settings.hasSecret && !settings.models?.length" class="ws-channel-note">
                {{ $t("projectAILoadCatalogHint") }}
            </p>
            <p
                v-if="sameConnection && settings.models?.length && settings.state !== 'verified'"
                class="ws-channel-note"
            >
                {{ $t("projectAIChooseTestHint") }}
            </p>
            <details v-if="form.mode !== 'off'" class="ws-evidence-history">
                <summary>{{ $t("projectAIExtraSettings") }}</summary>
                <div class="ws-wizard-fields mt-3">
                    <label>
                        {{ $t("projectAIDailyRequests") }}
                        <input
                            v-model.number="form.dailyLimit"
                            type="number"
                            min="1"
                            max="1000"
                            class="form-control"
                            required
                        />
                    </label>
                    <label v-if="form.mode !== 'off'">
                        {{ $t("projectAITimeLimit") }}
                        <input
                            v-model.number="form.timeoutSeconds"
                            type="number"
                            min="10"
                            max="120"
                            class="form-control"
                            required
                        />
                    </label>
                    <label v-if="keyMode">
                        {{ $t("projectAIAnswerLimit") }}
                        <input
                            v-model.number="form.maxOutputTokens"
                            type="number"
                            min="256"
                            max="8192"
                            class="form-control"
                            required
                        />
                    </label>
                </div>
                <fieldset v-if="form.mode !== 'off'" class="ws-project-privacy">
                    <legend>{{ $t("projectAIDataConsent") }}</legend>
                    <label class="ws-wizard-checkbox">
                        <input v-model="form.allowHistory" type="checkbox" />
                        {{ $t("projectAIShareHistory") }}
                    </label>
                    <label class="ws-wizard-checkbox">
                        <input v-model="form.allowNames" type="checkbox" />
                        {{ $t("projectAIShareNames") }}
                    </label>
                    <label class="ws-wizard-checkbox">
                        <input v-model="form.allowHosts" type="checkbox" />
                        {{ $t("projectAIShareHosts") }}
                    </label>
                    <p class="ws-channel-note">{{ $t("projectAINoSecrets") }}</p>
                </fieldset>
                <p class="ws-channel-note">{{ $t("projectAILimitsHonesty") }}</p>
            </details>
            <p v-if="sameConnection && settings.model && settings.hasSecret" class="ws-channel-note">
                {{ $t("projectAIProbeSpend") }}
            </p>
            <p v-if="form.mode === 'subscription'" class="ws-channel-note">
                {{ $t("projectAIPlanLimitHonesty") }}
                <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">
                    {{ $t("projectAIPlanUsage") }}
                </a>
            </p>
            <div class="ws-wizard-buttons">
                <button type="submit" class="ws-button ws-button-primary" :disabled="busy || !dirty">
                    {{ $t("Save") }}
                </button>
                <button
                    v-if="sameConnection && settings.hasSecret && form.mode !== 'off'"
                    type="button"
                    class="ws-button ws-button-quiet"
                    :disabled="busy || dirty || anthropicWorkerOld"
                    @click="loadModels"
                >
                    {{ $t("projectAILoadModels") }}
                </button>
                <button
                    v-if="sameConnection && settings.model && settings.hasSecret"
                    type="button"
                    class="ws-button ws-button-quiet"
                    :disabled="busy || dirty || pending || anthropicWorkerOld"
                    @click="probe"
                >
                    {{ $t("projectAIProbe") }}
                </button>
            </div>
        </form>
        <div v-if="canConfigure && loaded && settings.mode === 'subscription'" class="ws-project-connect">
            <p v-if="settings.account">{{ $t("projectAIAccount", { name: settings.account }) }}</p>
            <p class="ws-channel-note">{{ $t("projectAISubscriptionHelp") }}</p>
            <label v-if="settings.hasSecret || settings.hasRegistration" class="ws-wizard-checkbox">
                <input v-model="newAccount" type="checkbox" />
                {{ $t("projectAISwitchAccount") }}
            </label>
            <template v-if="localSignIn">
                <button class="ws-button ws-button-primary" :disabled="busy || dirty" @click="signIn">
                    Continue with ChatGPT
                </button>
                <a
                    v-if="authorizationURL"
                    :href="authorizationURL"
                    class="ws-button ws-button-quiet ms-2"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ $t("projectAIOpenSignIn") }}
                </a>
            </template>
            <template v-else>
                <p>{{ $t("projectAIRemoteHelp") }}</p>
                <div class="ws-wizard-buttons">
                    <a class="ws-button ws-button-quiet" href="/api/project-ai/helper" download>
                        {{ $t("projectAIGetHelper") }}
                    </a>
                    <button class="ws-button ws-button-primary" :disabled="busy || dirty" @click="downloadPairing">
                        {{ $t("projectAIGetPairing") }}
                    </button>
                </div>
                <p class="ws-channel-note">{{ $t("projectAIRunHelper") }}</p>
                <code>node uptime-kuma-ai-sign-in.cjs uptime-kuma-pairing.json</code>
            </template>
            <p class="ws-channel-note">{{ $t("projectAINoAccountBorrow") }}</p>
        </div>
        <section
            v-if="selectedMonitor && canDiagnose && settings.state === 'verified'"
            class="ws-project-diagnosis"
            data-testid="project-diagnosis"
        >
            <h3>{{ $t("projectAIExplain", { name: selectedMonitor.name }) }}</h3>
            <p>{{ $t("projectAIPreviewHelp") }}</p>
            <button v-if="!preview" class="ws-button ws-button-primary" :disabled="busy" @click="prepare">
                {{ $t("projectAIPreview") }}
            </button>
            <div v-if="preview">
                <dl class="ws-incident-facts">
                    <div>
                        <dt>{{ $t("projectAIEvidenceState") }}</dt>
                        <dd>{{ $t(`projectCurrent_${preview.evidence.state}`) }}</dd>
                    </div>
                    <div>
                        <dt>{{ $t("projectAIEvidenceReason") }}</dt>
                        <dd>{{ $t(preview.evidence.reason || `projectCurrent_${preview.evidence.state}`) }}</dd>
                    </div>
                </dl>
                <details class="ws-evidence-history">
                    <summary>{{ $t("projectAIExactData") }}</summary>
                    <pre>{{ JSON.stringify(preview.evidence, null, 2) }}</pre>
                </details>
                <p class="ws-channel-note">{{ $t("projectAIExplicitSend") }}</p>
                <div class="ws-wizard-buttons">
                    <button class="ws-button ws-button-primary" :disabled="busy || pending" @click="diagnose">
                        {{ $t("projectAISendDiagnosis") }}
                    </button>
                    <button class="ws-button ws-button-quiet" :disabled="busy" @click="preview = null">
                        {{ $t("Cancel") }}
                    </button>
                </div>
            </div>
        </section>
        <ProjectAIAutomation
            v-if="!guided && canConfigure && loaded"
            :key="`${projectId}-${settings.revision}-${publicState.projectRevision}`"
            :project-id="projectId"
        />
        <h3 v-if="!guided || jobs.length" class="mt-4">{{ $t("projectAIHistory") }}</h3>
        <p v-if="!guided && !jobs.length" class="ws-channel-note">{{ $t("projectAINoHistory") }}</p>
        <article
            v-for="job in jobs"
            :key="job.id"
            class="ws-project-ai-result"
            :class="{ 'pm-job-working': ['queued', 'running'].includes(job.status) }"
            :data-testid="`ai-job-${job.id}`"
        >
            <div class="ws-heading-row">
                <strong>
                    {{
                        $t(
                            job.kind === "probe"
                                ? "projectAIProbe"
                                : job.kind === "recovery"
                                  ? "projectRecoveryAIProposal"
                                  : job.kind === "code_patch"
                                    ? "codeRecoveryTitle"
                                    : job.kind === "code_review"
                                      ? "codeRecoveryReviewTitle"
                                      : "projectAIDiagnosis"
                        )
                    }}
                </strong>
                <span>{{ $t(`projectAIJob_${job.status}`) }}</span>
            </div>
            <p class="ws-channel-note">
                {{ formatTime(job.createdAt) }}
                <span v-if="job.trigger === 'automatic'">· {{ $t("premiumAutoTrigger") }}</span>
                <span v-if="job.monitorID">· #{{ job.monitorID }}</span>
            </p>
            <p v-if="job.errorCode" role="status">{{ $t(`projectAIError_${job.errorCode}`) }}</p>
            <router-link
                v-if="['code_patch', 'code_review'].includes(job.kind)"
                :to="`/projects/${projectId}?section=recovery&check=${job.monitorID}`"
                @click="$emit('open-recovery', job.monitorID)"
            >
                {{ $t("codeRecoveryOpenDetails") }}
            </router-link>
            <button
                v-if="
                    canDiagnose && ['queued', 'running'].includes(job.status) && (canConfigure || job.kind !== 'probe')
                "
                class="ws-button ws-button-quiet"
                :disabled="busy"
                @click="cancel(job.id)"
            >
                {{ $t("Cancel") }}
            </button>
            <div v-if="job.result">
                <h4>{{ $t("projectAIFacts") }}</h4>
                <ul>
                    <li v-for="(fact, index) in job.result.facts" :key="index">{{ fact }}</li>
                </ul>
                <h4>{{ $t("projectAIHypotheses") }}</h4>
                <ul>
                    <li v-for="(hypothesis, index) in job.result.hypotheses" :key="index">
                        {{ hypothesis.explanation }}
                        <small>({{ $t(`projectAIConfidence_${hypothesis.confidence}`) }})</small>
                    </li>
                </ul>
                <h4>{{ $t("projectAINextSteps") }}</h4>
                <ol>
                    <li v-for="(step, index) in job.result.nextSteps" :key="index">{{ step }}</li>
                </ol>
                <h4>{{ $t("projectAILimitations") }}</h4>
                <ul>
                    <li v-for="(limitation, index) in job.result.limitations" :key="index">{{ limitation }}</li>
                </ul>
            </div>
            <p v-if="job.usage" class="ws-channel-note">
                {{
                    $t("projectAITokenUsage", {
                        input: job.usage.input_tokens ?? "—",
                        output: job.usage.output_tokens ?? "—",
                    })
                }}
                · {{ $t("projectAICostUnknown") }}
            </p>
            <p v-if="['uncertain', 'cancelled', 'failed'].includes(job.status)" class="ws-channel-note">
                {{ $t("projectAIUncertainCost") }}
            </p>
        </article>
    </section>
</template>
<script>
import { projectRequest } from "../project-workflow";
import ProjectAIAutomation from "./ProjectAIAutomation.vue";
export default {
    components: { ProjectAIAutomation },
    props: {
        projectId: { type: Number, required: true },
        role: { type: String, required: true },
        guided: { type: Boolean, default: false },
        selectedMonitor: { type: Object, default: null },
        publicState: { type: Object, default: () => ({ state: "off" }) },
    },
    emits: ["open-recovery"],
    data() {
        return {
            form: {},
            settings: {},
            jobs: [],
            apiKey: "",
            error: "",
            notice: "",
            dirty: false,
            loaded: false,
            busy: false,
            refreshing: false,
            localSignIn: false,
            newAccount: false,
            authorizationURL: "",
            preview: null,
            clock: null,
            generation: 0,
            worker: null,
        };
    },
    computed: {
        canConfigure() {
            return this.role === "admin";
        },
        keyMode() {
            return ["api", "anthropic"].includes(this.form.mode);
        },
        sameConnection() {
            return this.form.mode === this.settings.mode;
        },
        anthropicWorkerOld() {
            return (
                this.form.mode === "anthropic" &&
                this.worker?.enabled &&
                this.worker.connected &&
                !this.worker.providers?.includes("anthropic")
            );
        },
        canDiagnose() {
            return ["admin", "operator"].includes(this.role);
        },
        pending() {
            return this.jobs.some((job) => ["queued", "running"].includes(job.status));
        },
    },
    watch: {
        publicState(value) {
            if (!this.canConfigure) {
                this.settings = value;
            }
        },
        "selectedMonitor.id"() {
            this.preview = null;
        },
        role() {
            this.generation++;
            this.settings = {};
            this.worker = null;
            this.form = {};
            this.apiKey = "";
            this.jobs = [];
            this.loaded = false;
            this.refreshing = false;
            this.load();
        },
    },
    mounted() {
        this.settings = this.publicState;
        this.load();
        this.clock = setInterval(() => this.load(), 4000);
    },
    beforeUnmount() {
        this.generation++;
        clearInterval(this.clock);
        this.apiKey = "";
        this.authorizationURL = "";
    },
    methods: {
        /** @returns {void} Keep a draft key and model with the provider they were chosen for. */
        chooseConnection() {
            this.apiKey = "";
            this.form.model = this.sameConnection ? this.settings.model : "";
            this.form.allowHistory = this.sameConnection && this.settings.allowHistory;
            this.form.allowNames = this.sameConnection && this.settings.allowNames;
            this.form.allowHosts = this.sameConnection && this.settings.allowHosts;
            this.authorizationURL = "";
        },
        /**
         * @param {boolean} force Discard a stale local form after an explicit refresh
         * @returns {Promise<void>} Refresh local facts without making any inference request
         */
        async load(force = false) {
            if (this.refreshing || !this.$root.socket.connected) {
                return;
            }
            const generation = this.generation;
            this.refreshing = true;
            try {
                const result = await projectRequest(this.$root, "projectAIJobs", { projectID: this.projectId });
                const data = this.canConfigure
                    ? await projectRequest(this.$root, "projectAISettings", { projectID: this.projectId })
                    : null;
                if (generation !== this.generation) {
                    return;
                }
                this.jobs = result.jobs;
                if (data) {
                    this.worker = data.worker;
                    this.localSignIn = data.localSignIn;
                    this.settings = data.settings;
                    if (!this.loaded || force || !this.dirty) {
                        this.form = { ...data.settings };
                        this.dirty = false;
                    }
                }
                this.loaded = true;
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                    if (error.message === "projectAccessDenied") {
                        this.jobs = [];
                        this.settings = {};
                        this.worker = null;
                        this.form = {};
                        this.apiKey = "";
                    }
                }
            } finally {
                if (generation === this.generation) {
                    this.refreshing = false;
                }
            }
        },
        /**
         * @param {string} event Action
         * @param {object} data Payload
         * @returns {Promise<object|null>} Authorized result
         */
        async act(event, data = {}) {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            this.notice = "";
            try {
                const result = await projectRequest(this.$root, event, { ...data, projectID: this.projectId });
                if (generation !== this.generation) {
                    return null;
                }
                return result;
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
        /** @returns {Promise<void>} Save without probing or charging automatically */
        async save() {
            const result = await this.act("projectAISave", { ...this.form, apiKey: this.apiKey });
            if (result) {
                this.apiKey = "";
                this.settings = result.settings;
                this.form = { ...result.settings };
                this.dirty = false;
                this.notice = result.remoteRevoked ? "projectAISavedNoCall" : "projectAIRevocationUnknown";
            }
        },
        /** @returns {Promise<void>} Explicit fresh account-specific catalog */
        async loadModels() {
            const result = await this.act("projectAIModels", { revision: this.settings.revision });
            if (result) {
                this.settings.models = result.models;
                this.notice = result.models.length ? "projectAIModelsLoaded" : "projectAICatalogEmpty";
            }
        },
        /** @returns {Promise<void>} Probe success is recorded only by the completed worker */
        async probe() {
            const result = await this.act("projectAIEnqueue", { kind: "probe", revision: this.settings.revision });
            if (result) {
                await this.load();
            }
        },
        /** @returns {Promise<void>} Start this administrator's own official login */
        async signIn() {
            const result = await this.act("projectAISignIn", {
                revision: this.settings.revision,
                newAccount: this.newAccount,
            });
            if (result) {
                this.authorizationURL = result.authorizationURL;
                this.notice = "projectAISignInPending";
            }
        },
        /** @returns {Promise<void>} One-use pairing file contains no previously saved AI credentials */
        async downloadPairing() {
            const result = await this.act("projectAIPairing", {
                revision: this.settings.revision,
                newAccount: this.newAccount,
            });
            if (result) {
                const url = URL.createObjectURL(
                    new Blob([JSON.stringify(result.pairing, null, 2)], { type: "application/json" })
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "uptime-kuma-pairing.json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                this.notice = "projectAISignInPending";
            }
        },
        /** @returns {Promise<void>} Show exact consented evidence before requesting inference */
        async prepare() {
            this.preview = await this.act("projectAIPrepare", { monitorID: this.selectedMonitor.id });
        },
        /** @returns {Promise<void>} Explicit one-shot explanation of the approved evidence */
        async diagnose() {
            const result = await this.act("projectAIEnqueue", {
                kind: "diagnosis",
                monitorID: this.selectedMonitor.id,
                revision: this.preview.revision,
                evidenceHash: this.preview.hash,
            });
            if (result) {
                this.preview = null;
                await this.load();
            }
        },
        /**
         * @param {number} jobID Job
         * @returns {Promise<void>} Explicit cancellation
         */
        async cancel(jobID) {
            await this.act("projectAICancel", { id: jobID });
            await this.load();
        },
        /**
         * @param {number} value UTC time
         * @returns {string} Local readable date
         */
        formatTime(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: "short", timeStyle: "short" }).format(
                new Date(Number(value))
            );
        },
    },
};
</script>
