<template>
    <section class="ws-project-panel" data-testid="project-tracking">
        <div class="ws-heading-row">
            <div>
                <h2>{{ $t("premiumTrackingTitle") }}</h2>
                <p class="ws-subtitle">{{ $t("premiumTrackingHelp") }}</p>
            </div>
            <WorkspaceIcon name="activity" />
        </div>
        <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
        <p v-if="notice" role="status">{{ $t(notice) }}</p>
        <p v-if="data?.truncated" class="ws-channel-note">{{ $t("premiumTrackingTruncated") }}</p>
        <template v-if="data">
            <label class="ws-project-picker">
                {{ $t("workspaceService") }}
                <select v-model.number="monitorID" class="form-select">
                    <option v-for="monitor in data.monitors" :key="monitor.id" :value="monitor.id">
                        {{ monitor.name }}
                    </option>
                </select>
            </label>
            <template v-if="selected">
                <div class="pm-tracking-facts">
                    <div>
                        <WorkspaceIcon name="activity" />
                        <h3>{{ $t("premiumLatencyTitle") }}</h3>
                        <p>{{ $t(`premiumTrend_${selected.trend.state}`) }}</p>
                        <p v-if="selected.trend.samples" class="ws-channel-note">
                            {{
                                $t("premiumTrendValues", {
                                    before: milliseconds(selected.trend.before),
                                    recent: milliseconds(selected.trend.recent),
                                })
                            }}
                        </p>
                        <small>{{ $t("premiumTrendHonesty") }}</small>
                    </div>
                    <div>
                        <WorkspaceIcon name="folder" />
                        <h3>{{ $t("premiumDependenciesTitle") }}</h3>
                        <ul v-if="dependencies.length">
                            <li v-for="item in dependencies" :key="item.id">
                                {{ item.name }} · {{ $t(`projectCurrent_${item.state}`) }}
                            </li>
                        </ul>
                        <p v-else>{{ $t("premiumNoDependencies") }}</p>
                        <small>{{ $t("premiumDependencyHonesty") }}</small>
                    </div>
                </div>
                <form v-if="canManage" class="pm-dependency-form" @submit.prevent="save">
                    <fieldset>
                        <legend>{{ $t("premiumSelectDependencies") }}</legend>
                        <label v-for="monitor in candidates" :key="monitor.id" class="ws-wizard-checkbox">
                            <input v-model="selectedIDs" type="checkbox" :value="monitor.id" @change="dirty = true" />
                            {{ monitor.name }}
                        </label>
                    </fieldset>
                    <button
                        type="submit"
                        class="ws-button ws-button-primary"
                        :disabled="busy || !dirty || selectedIDs.length > 5"
                    >
                        {{ $t("Save") }}
                    </button>
                    <button
                        v-if="dirty"
                        type="button"
                        class="ws-button ws-button-quiet"
                        :disabled="busy"
                        @click="discard"
                    >
                        {{ $t("Cancel") }}
                    </button>
                </form>
            </template>
        </template>
    </section>
</template>
<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
import { projectRequest } from "../project-workflow";
export default {
    components: { WorkspaceIcon },
    props: {
        projectId: { type: Number, required: true },
        role: { type: String, required: true },
        selectedMonitor: { type: Object, default: null },
    },
    data() {
        return {
            data: null,
            monitorID: null,
            selectedIDs: [],
            dirty: false,
            reviewRevision: null,
            busy: false,
            loading: false,
            error: "",
            notice: "",
            generation: 0,
            clock: null,
        };
    },
    computed: {
        canManage() {
            return ["admin", "operator"].includes(this.role);
        },
        selected() {
            return this.data?.monitors.find((monitor) => monitor.id === this.monitorID);
        },
        candidates() {
            return (
                this.data?.monitors.filter((monitor) => monitor.id !== this.monitorID && monitor.type !== "group") || []
            );
        },
        dependencies() {
            return this.data?.monitors.filter((monitor) => this.selected?.dependencies.includes(monitor.id)) || [];
        },
    },
    watch: {
        monitorID() {
            this.selectedIDs = [...(this.selected?.dependencies || [])];
            this.reviewRevision = this.data?.project.revision ?? null;
            this.dirty = false;
            this.error = "";
            this.notice = "";
        },
        role() {
            this.reset();
            this.load();
        },
        projectId() {
            this.reset();
            this.load();
        },
        "$root.socket.connected"() {
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
    },
    mounted() {
        this.load();
        this.clock = setInterval(() => this.load(), 15000);
    },
    beforeUnmount() {
        this.reset();
        clearInterval(this.clock);
    },
    methods: {
        /** @returns {void} Forget revoked project data and edits. */
        reset() {
            this.generation++;
            this.data = null;
            this.monitorID = null;
            this.selectedIDs = [];
            this.dirty = false;
            this.reviewRevision = null;
            this.busy = false;
            this.loading = false;
            this.error = "";
        },
        /** @returns {Promise<void>} Read scoped links and real measured trends. */
        async load() {
            if (!this.$root.loggedIn || !this.$root.socket.connected || this.loading || this.busy) return;
            const generation = this.generation;
            this.loading = true;
            try {
                const result = await projectRequest(this.$root, "projectTrackingGet", { projectID: this.projectId });
                if (generation !== this.generation) return;
                this.data = result;
                if (!this.monitorID)
                    this.monitorID =
                        result.monitors.find((monitor) => monitor.id === this.selectedMonitor?.id)?.id ||
                        result.monitors[0]?.id ||
                        null;
                if (!this.dirty) {
                    this.selectedIDs = [...(this.selected?.dependencies || [])];
                    this.reviewRevision = result.project.revision;
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.reset();
                    this.error = error.message;
                }
            } finally {
                if (generation === this.generation) this.loading = false;
            }
        },
        /** @returns {Promise<void>} Save reviewed acyclic advisory links only. */
        async save() {
            if (this.busy || !this.data) return;
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                await projectRequest(this.$root, "projectTrackingSave", {
                    projectID: this.projectId,
                    revision: this.reviewRevision,
                    monitorID: this.monitorID,
                    dependencies: this.selectedIDs,
                });
                if (generation !== this.generation) return;
                this.dirty = false;
                this.notice = "premiumDependenciesSaved";
            } catch (error) {
                if (generation === this.generation) {
                    if (["projectAccessDenied", "projectAuthRequired"].includes(error.message)) this.reset();
                    this.error = error.message;
                }
            } finally {
                if (generation === this.generation) {
                    this.busy = false;
                    await this.load();
                }
            }
        },
        /** @returns {void} Reload the latest reviewed selection before accepting a new edit. */
        discard() {
            this.selectedIDs = [...(this.selected?.dependencies || [])];
            this.reviewRevision = this.data?.project.revision ?? null;
            this.dirty = false;
            this.error = "";
        },
        /**
         * @param {number} value Measured milliseconds
         * @returns {string} Readable measured value
         */
        milliseconds(value) {
            return this.$t("workspaceMilliseconds", {
                value: new Intl.NumberFormat(this.$i18n.locale, { maximumFractionDigits: 1 }).format(value),
            });
        },
    },
};
</script>
