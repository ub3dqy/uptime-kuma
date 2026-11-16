<template>
    <aside class="pm-incident-ai" data-testid="incident-ai">
        <div class="pm-ai-heading">
            <span class="pm-ai-emblem"><WorkspaceIcon name="sparkles" /></span>
            <div>
                <p class="ws-eyebrow">{{ $t("premiumPersonalAI") }}</p>
                <h3>{{ $t("premiumAIIncidentTitle") }}</h3>
            </div>
        </div>
        <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
        <p v-if="!loaded" class="ws-channel-note">{{ $t("premiumAILoading") }}</p>
        <template v-else>
            <p class="ws-channel-note">{{ $t("premiumAIIncidentHelp") }}</p>
            <div v-if="pending" class="pm-ai-progress" role="status">
                <span class="pm-progress-orbit" />
                <span>{{ $t(`projectAIJob_${pending.status}`) }}</span>
            </div>
            <article v-if="latest" class="pm-ai-explanation">
                <p class="ws-channel-note">
                    {{ formatTime(latest.createdAt) }} · {{ $t(`projectAIJob_${latest.status}`) }}
                </p>
                <p v-if="latest.errorCode">{{ $t(`projectAIError_${latest.errorCode}`) }}</p>
                <template v-if="latest.result">
                    <h4>{{ $t("projectAIFacts") }}</h4>
                    <ul>
                        <li v-for="(fact, index) in latest.result.facts" :key="index">{{ fact }}</li>
                    </ul>
                    <h4>{{ $t("projectAIHypotheses") }}</h4>
                    <ul>
                        <li v-for="(item, index) in latest.result.hypotheses" :key="index">
                            {{ item.explanation }}
                            <small>({{ $t(`projectAIConfidence_${item.confidence}`) }})</small>
                        </li>
                    </ul>
                    <h4>{{ $t("projectAINextSteps") }}</h4>
                    <ol>
                        <li v-for="(step, index) in latest.result.nextSteps" :key="index">{{ step }}</li>
                    </ol>
                    <details>
                        <summary>{{ $t("projectAILimitations") }}</summary>
                        <ul>
                            <li v-for="(item, index) in latest.result.limitations" :key="index">{{ item }}</li>
                        </ul>
                    </details>
                </template>
            </article>
            <p v-else-if="!pending" class="pm-ai-empty">
                {{ $t(verified ? "premiumAINoExplanation" : "premiumAINeedsConnection") }}
            </p>
            <template v-if="verified && canDiagnose">
                <button
                    v-if="!preview"
                    type="button"
                    class="ws-button ws-button-primary"
                    :disabled="busy || !!pending"
                    @click="prepare"
                >
                    <WorkspaceIcon name="sparkles" />
                    {{ $t("projectAIPreview") }}
                </button>
                <div v-else class="pm-ai-preview">
                    <p>{{ $t("projectAIExplicitSend") }}</p>
                    <details open>
                        <summary>{{ $t("projectAIExactData") }}</summary>
                        <pre>{{ JSON.stringify(preview.evidence, null, 2) }}</pre>
                    </details>
                    <div class="ws-wizard-buttons">
                        <button
                            type="button"
                            class="ws-button ws-button-primary"
                            :disabled="busy || !!pending"
                            @click="diagnose"
                        >
                            {{ $t("projectAISendDiagnosis") }}
                        </button>
                        <button
                            type="button"
                            class="ws-button ws-button-quiet"
                            :disabled="busy"
                            @click="preview = null"
                        >
                            {{ $t("Cancel") }}
                        </button>
                    </div>
                </div>
            </template>
            <div v-if="resolvedID" class="pm-ai-links">
                <router-link
                    :to="{ path: `/projects/${resolvedID}`, query: { check: String(monitorId), section: 'ai' } }"
                >
                    {{ $t(verified ? "premiumAISettings" : "premiumAIConnect") }}
                    <WorkspaceIcon name="arrow" />
                </router-link>
                <router-link
                    :to="{ path: `/projects/${resolvedID}`, query: { check: String(monitorId), section: 'recovery' } }"
                >
                    {{ $t("premiumSafeRecovery") }}
                    <WorkspaceIcon name="shield" />
                </router-link>
            </div>
        </template>
    </aside>
</template>

<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
import { projectRequest } from "../project-workflow";
export default {
    components: { WorkspaceIcon },
    props: {
        monitorId: { type: Number, required: true },
        projectId: { type: Number, default: null },
    },
    data() {
        return {
            resolvedID: null,
            role: null,
            verified: false,
            jobs: [],
            preview: null,
            loaded: false,
            busy: false,
            refreshing: false,
            error: "",
            generation: 0,
            clock: null,
        };
    },
    computed: {
        canDiagnose() {
            return ["admin", "operator"].includes(this.role);
        },
        pending() {
            return this.jobs.find((job) => ["queued", "running"].includes(job.status));
        },
        latest() {
            return this.jobs.find((job) => !["queued", "running"].includes(job.status));
        },
    },
    watch: {
        monitorId() {
            this.reset();
            this.load();
        },
        projectId() {
            this.reset();
            this.load();
        },
        "$root.username"() {
            this.reset();
            this.load();
        },
        "$root.loggedIn"() {
            this.reset();
            this.load();
        },
        "$root.socket.connected"() {
            this.reset();
            this.load();
        },
    },
    mounted() {
        this.load();
        this.clock = setInterval(() => this.load(), 5000);
    },
    beforeUnmount() {
        this.reset();
        clearInterval(this.clock);
    },
    methods: {
        /** @returns {void} Clear private content immediately when its authorization changes. */
        reset() {
            this.generation++;
            this.resolvedID = null;
            this.role = null;
            this.verified = false;
            this.jobs = [];
            this.preview = null;
            this.loaded = false;
            this.busy = false;
            this.refreshing = false;
            this.error = "";
        },
        /** @returns {Promise<void>} Read scoped settings and results without starting inference. */
        async load() {
            if (!this.$root.loggedIn || !this.$root.socket.connected || this.refreshing || this.busy) return;
            const generation = this.generation;
            this.refreshing = true;
            try {
                let projectID = this.projectId || this.resolvedID;
                if (!projectID) {
                    const { projects } = await projectRequest(this.$root, "projectList");
                    projectID = projects.find((project) => project.personal)?.id;
                }
                if (!projectID) throw new Error("projectAccessDenied");
                const snapshot = await projectRequest(this.$root, "projectSnapshot", { projectID });
                if (!snapshot.monitors.some((monitor) => monitor.id === this.monitorId))
                    throw new Error("projectAccessDenied");
                const { jobs } = await projectRequest(this.$root, "projectAIJobs", { projectID });
                if (generation !== this.generation) return;
                if (this.role && this.role !== snapshot.project.role) this.preview = null;
                this.resolvedID = projectID;
                this.role = snapshot.project.role;
                this.verified = snapshot.ai.state === "verified";
                this.jobs = jobs.filter((job) => job.kind === "diagnosis" && job.monitorID === this.monitorId);
                this.loaded = true;
                this.error = "";
            } catch (error) {
                if (generation === this.generation) {
                    this.reset();
                    this.error = error.message;
                    this.loaded = true;
                }
            } finally {
                if (generation === this.generation) this.refreshing = false;
            }
        },
        /**
         * @param {string} event Closed project operation
         * @param {object} request Scoped input
         * @returns {Promise<object|null>} Current authorized result
         */
        async act(event, request = {}) {
            if (this.busy || !this.resolvedID) return null;
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                const result = await projectRequest(this.$root, event, { projectID: this.resolvedID, ...request });
                return generation === this.generation ? result : null;
            } catch (error) {
                if (generation === this.generation) {
                    if (["projectAccessDenied", "projectAuthRequired"].includes(error.message)) this.reset();
                    this.error = error.message;
                }
                return null;
            } finally {
                if (generation === this.generation) this.busy = false;
            }
        },
        /** @returns {Promise<void>} Show exact evidence for this check. */
        async prepare() {
            this.preview = await this.act("projectAIPrepare", { monitorID: this.monitorId });
        },
        /** @returns {Promise<void>} Request only the evidence explicitly reviewed by the owner. */
        async diagnose() {
            const result = await this.act("projectAIEnqueue", {
                kind: "diagnosis",
                monitorID: this.monitorId,
                revision: this.preview.revision,
                evidenceHash: this.preview.hash,
            });
            if (result) {
                this.preview = null;
                await this.load();
            }
        },
        /**
         * @param {number} value Saved UTC time
         * @returns {string} Local time
         */
        formatTime(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: "short", timeStyle: "short" }).format(
                Number(value)
            );
        },
    },
};
</script>
