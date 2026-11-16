<template>
    <div class="ws-projects" data-testid="projects-page">
        <div class="ws-heading-row">
            <div>
                <p class="ws-eyebrow">{{ $t("projectWorkspace") }}</p>
                <h1 class="ws-page-title">{{ $t("projectTitle") }}</h1>
                <p class="ws-subtitle">{{ $t("projectIntro") }}</p>
            </div>
            <button v-if="canCreate" class="ws-button ws-button-primary" @click="creating = !creating">
                {{ $t("projectCreate") }}
            </button>
        </div>
        <p v-if="error" role="alert" class="ws-form-error">{{ $t(error) }}</p>
        <form v-if="creating" class="ws-alert-wizard" data-testid="project-create-form" @submit.prevent="create">
            <h2>{{ $t("projectCreate") }}</h2>
            <div class="ws-wizard-fields">
                <label>
                    {{ $t("projectName") }}
                    <input v-model="newName" class="form-control" required maxlength="120" />
                </label>
                <label>
                    {{ $t("projectTimezone") }}
                    <input v-model="newZone" class="form-control" required maxlength="64" />
                </label>
                <label v-if="$root.projectAccess.installationAdmin">
                    {{ $t("projectAllowedIPs") }}
                    <input v-model="newIPs" class="form-control" placeholder="127.0.0.1" />
                    <small>{{ $t("projectAllowedIPsHelp") }}</small>
                </label>
            </div>
            <button class="ws-button ws-button-primary" type="submit" :disabled="busy">
                {{ $t("projectCreate") }}
            </button>
        </form>
        <label v-if="projects.length" class="ws-project-picker">
            {{ $t("projectChoose") }}
            <select :value="selectedID || ''" class="form-select" @change="select($event.target.value)">
                <option v-for="item in projects" :key="item.id" :value="item.id">
                    {{ item.name }} · {{ $t(`projectRole_${item.role}`) }}
                </option>
            </select>
        </label>
        <p v-else-if="!loading" class="ws-channel-note">{{ $t("projectNoAccess") }}</p>
        <div v-if="snapshot && !blocked" :key="snapshot.project.id">
            <div class="ws-project-heading">
                <div>
                    <h2>{{ snapshot.project.name }}</h2>
                    <p class="ws-channel-note">
                        {{ $t(`projectRole_${snapshot.project.role}`) }} · {{ snapshot.project.timezone }}
                        <span v-if="snapshot.project.personal">· {{ $t("projectPersonalWorkspace") }}</span>
                    </p>
                </div>
                <button v-if="isAdmin" class="ws-button ws-button-quiet" @click="renaming = !renaming">
                    {{ $t("projectSettings") }}
                </button>
            </div>
            <form
                v-if="renaming && isAdmin"
                class="ws-alert-wizard"
                data-testid="project-settings-form"
                @submit.prevent="rename"
            >
                <div class="ws-wizard-fields">
                    <label>
                        {{ $t("projectName") }}
                        <input v-model="editName" class="form-control" required maxlength="120" />
                    </label>
                    <label>
                        {{ $t("projectTimezone") }}
                        <input v-model="editZone" class="form-control" required maxlength="64" />
                    </label>
                    <label v-if="$root.projectAccess.installationAdmin">
                        {{ $t("projectAllowedIPs") }}
                        <input v-model="editIPs" class="form-control" />
                        <small>{{ $t("projectAllowedIPsHelp") }}</small>
                    </label>
                </div>
                <button class="ws-button ws-button-primary" type="submit" :disabled="busy">{{ $t("Save") }}</button>
            </form>
            <nav class="ws-project-tabs" :aria-label="$t('projectSections')">
                <button
                    v-for="tab in visibleTabs"
                    :key="tab"
                    type="button"
                    :class="{ active: section === tab }"
                    :aria-pressed="section === tab"
                    @click="section = tab"
                >
                    {{ $t(`projectTab_${tab}`) }}
                </button>
            </nav>
            <section v-if="section === 'checks'" class="ws-project-panel">
                <div class="ws-heading-row">
                    <h2>{{ $t("workspaceNavServices") }}</h2>
                    <button v-if="canOperate" class="ws-button ws-button-primary" @click="openEditor(null)">
                        {{ $t("projectAddCheck") }}
                    </button>
                </div>
                <p v-if="snapshot.project.personal" class="ws-channel-note">
                    {{ $t("projectPersonalHelp") }}
                    <router-link v-if="!$root.projectAccess.projectOnly" to="/dashboard">
                        {{ $t("projectOpenPersonal") }}
                    </router-link>
                </p>
                <p v-if="snapshot.truncated" class="ws-channel-note">{{ $t("projectFirstChecksOnly") }}</p>
                <ProjectMonitorEditor
                    v-if="editorOpen && canOperate"
                    :key="`${selectedID}-${editorID || 'new'}`"
                    :project-id="selectedID"
                    :monitor-id="editorID"
                    @close="editorOpen = false"
                    @saved="savedMonitor"
                />
                <p v-if="!snapshot.monitors.length" class="ws-channel-note">{{ $t("projectNoChecks") }}</p>
                <ul class="ws-project-check-list">
                    <li v-for="monitor in snapshot.monitors" :key="monitor.id">
                        <button
                            class="ws-project-check"
                            :aria-pressed="monitor.id === monitorID"
                            @click="monitorID = monitor.id"
                        >
                            <WorkspaceIcon
                                :name="
                                    monitor.state === 'up' ? 'check' : monitor.state === 'down' ? 'warning' : 'clock'
                                "
                            />
                            <span>
                                <strong>{{ monitor.name }}</strong>
                                <small>{{ monitor.hostname || $t("workspacePrivateService") }}</small>
                            </span>
                            <span class="ws-state" :class="`ws-state-${monitor.state}`">
                                <span />
                                {{ $t(checkStateLabel(monitor)) }}
                            </span>
                        </button>
                    </li>
                </ul>
                <div v-if="selectedMonitor" class="ws-project-selected" data-testid="project-check-details">
                    <div class="ws-heading-row">
                        <h3>{{ selectedMonitor.name }}</h3>
                        <div class="ws-wizard-buttons">
                            <button
                                v-if="canOperate"
                                class="ws-button ws-button-quiet"
                                :disabled="busy"
                                @click="control(selectedMonitor)"
                            >
                                {{ $t(selectedMonitor.active ? "Pause" : "Resume") }}
                            </button>
                            <button
                                v-if="canOperate && snapshot.ai.state === 'verified'"
                                class="ws-button ws-button-primary"
                                @click="section = 'ai'"
                            >
                                {{ $t("projectAIExplainButton") }}
                            </button>
                        </div>
                    </div>
                    <IncidentCard
                        :monitor="selectedMonitor"
                        :observations="selectedMonitor.observations"
                        :project-id="selectedID"
                        :can-manage="canOperate && !snapshot.project.personal"
                        @edit="openEditor(selectedMonitor.id)"
                        @alerts="section = 'channels'"
                    />
                    <MonitorVerification
                        v-if="selectedMonitor.witnessSite || selectedMonitor.browserJourney"
                        :key="`${selectedID}-${monitorID}-verification`"
                        :project-id="selectedID"
                        :monitor-id="monitorID"
                    />
                    <DeliveryHistory
                        :key="`${selectedID}-${monitorID}`"
                        :monitor-id="monitorID"
                        :delivery-request="deliveryRequest"
                        compact
                    />
                </div>
            </section>
            <ProjectMembers v-if="section === 'members' && isAdmin" :project="snapshot.project" @changed="refresh" />
            <ProjectTracking
                v-if="section === 'tracking'"
                :project-id="selectedID"
                :role="snapshot.project.role"
                :selected-monitor="selectedMonitor"
            />
            <ProjectChannels
                v-if="section === 'channels'"
                :project-id="selectedID"
                :monitors="snapshot.monitors"
                :can-manage="isAdmin"
            />
            <ProjectAI
                v-if="section === 'ai'"
                :project-id="selectedID"
                :role="snapshot.project.role"
                :selected-monitor="selectedMonitor"
                :public-state="snapshot.ai"
                @open-recovery="openCodeRecovery"
            />
            <ProjectRecovery
                v-if="section === 'recovery'"
                :project-id="selectedID"
                :role="snapshot.project.role"
                :ai-state="snapshot.ai.state"
            />
            <ProjectCodeRecovery
                v-if="section === 'recovery'"
                :project-id="selectedID"
                :role="snapshot.project.role"
                :ai-state="snapshot.ai.state"
                :selected-monitor="selectedMonitor"
            />
            <section v-if="section === 'reports'" class="ws-project-panel" data-testid="project-report">
                <h2>{{ $t("workspaceNavReports") }}</h2>
                <p class="ws-channel-note">{{ $t("projectReportHonesty") }}</p>
                <form @submit.prevent="report">
                    <div class="ws-wizard-fields">
                        <label>
                            {{ $t("projectReportCheck") }}
                            <select v-model.number="reportMonitorID" class="form-select" required>
                                <option v-for="monitor in snapshot.monitors" :key="monitor.id" :value="monitor.id">
                                    {{ monitor.name }}
                                </option>
                            </select>
                        </label>
                        <label>
                            {{ $t("projectReportFrom") }}
                            <input v-model="reportStart" class="form-control" type="datetime-local" required />
                        </label>
                        <label>
                            {{ $t("projectReportTo") }}
                            <input v-model="reportEnd" class="form-control" type="datetime-local" required />
                        </label>
                    </div>
                    <button class="ws-button ws-button-primary" type="submit" :disabled="busy">
                        {{ $t("projectBuildReport") }}
                    </button>
                </form>
                <dl v-if="summary" class="ws-incident-facts">
                    <div>
                        <dt>{{ $t("projectReportAvailability") }}</dt>
                        <dd>{{ percent(summary.availability) }}</dd>
                    </div>
                    <div>
                        <dt>{{ $t("projectReportCoverage") }}</dt>
                        <dd>{{ percent(summary.coverage) }}</dd>
                    </div>
                    <div>
                        <dt>{{ $t("projectReportObservations") }}</dt>
                        <dd>{{ summary.counts.total }}</dd>
                    </div>
                    <div>
                        <dt>{{ $t("projectReportUnknown") }}</dt>
                        <dd>{{ Math.round(summary.time.unknown / 1000) }} {{ $t("projectSeconds") }}</dd>
                    </div>
                </dl>
            </section>
            <section v-if="section === 'audit' && isAdmin" class="ws-project-panel">
                <h2>{{ $t("projectAuditTitle") }}</h2>
                <button class="ws-button ws-button-quiet" @click="loadAudit">{{ $t("projectRefresh") }}</button>
                <ul class="ws-project-audit-list">
                    <li v-for="event in events" :key="event.id">
                        <span>{{ $t(`projectAudit_${event.action}`) }}</span>
                        <small>
                            {{ event.username || "—" }} · {{ formatTime(event.created_at) }}
                            <span v-if="event.target">· #{{ event.target }}</span>
                        </small>
                    </li>
                </ul>
            </section>
        </div>
        <p v-else-if="loading" class="ws-channel-note" role="status">{{ $t("projectLoading") }}</p>
    </div>
</template>
<script>
import WorkspaceIcon from "../components/WorkspaceIcon.vue";
import IncidentCard from "../components/IncidentCard.vue";
import MonitorVerification from "../components/MonitorVerification.vue";
import DeliveryHistory from "../components/DeliveryHistory.vue";
import ProjectMonitorEditor from "../components/ProjectMonitorEditor.vue";
import ProjectMembers from "../components/ProjectMembers.vue";
import ProjectChannels from "../components/ProjectChannels.vue";
import ProjectAI from "../components/ProjectAI.vue";
import ProjectRecovery from "../components/ProjectRecovery.vue";
import ProjectCodeRecovery from "../components/ProjectCodeRecovery.vue";
import ProjectTracking from "../components/ProjectTracking.vue";
import { projectRequest, projectChannelRequest } from "../project-workflow";
import { workLabel } from "../site-work.ts";
export default {
    components: {
        WorkspaceIcon,
        IncidentCard,
        MonitorVerification,
        DeliveryHistory,
        ProjectMonitorEditor,
        ProjectMembers,
        ProjectChannels,
        ProjectAI,
        ProjectRecovery,
        ProjectCodeRecovery,
        ProjectTracking,
    },
    data() {
        return {
            projects: [],
            snapshot: null,
            loading: true,
            refreshing: false,
            busy: false,
            blocked: false,
            error: "",
            section: "checks",
            creating: false,
            newName: "",
            newZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            newIPs: "",
            renaming: false,
            editName: "",
            editZone: "",
            editIPs: "",
            monitorID: null,
            editorID: null,
            editorOpen: false,
            events: [],
            generation: 0,
            clock: null,
            summary: null,
            reportMonitorID: null,
            reportStart: new Date(Date.now() - 86400000).toISOString().slice(0, 16),
            reportEnd: new Date().toISOString().slice(0, 16),
        };
    },
    computed: {
        selectedID() {
            const value = Number(this.$route.params.projectID);
            return Number.isSafeInteger(value) && value > 0 ? value : null;
        },
        isAdmin() {
            return this.snapshot?.project.role === "admin";
        },
        canOperate() {
            return ["admin", "operator"].includes(this.snapshot?.project.role);
        },
        canCreate() {
            return (
                this.$root.projectAccess.installationAdmin || this.projects.some((project) => project.role === "admin")
            );
        },
        visibleTabs() {
            return [
                "checks",
                "tracking",
                "channels",
                "ai",
                "recovery",
                "reports",
                ...(this.isAdmin ? ["members", "audit"] : []),
            ];
        },
        selectedMonitor() {
            return this.snapshot?.monitors.find((monitor) => monitor.id === this.monitorID) || null;
        },
        deliveryRequest() {
            const request = projectChannelRequest(this.$root, this.selectedID);
            return (data) => request("getNotificationDelivery", data);
        },
    },
    watch: {
        selectedID() {
            this.generation++;
            this.snapshot = null;
            this.summary = null;
            this.events = [];
            this.monitorID = null;
            this.editorOpen = false;
            this.section = "checks";
            this.blocked = false;
            this.refreshing = false;
            this.refresh();
        },
        "$root.socket.connected"(connected) {
            if (connected) {
                this.loadProjects();
            }
        },
        "$route.query.check"() {
            this.monitorID = null;
            this.section = "checks";
            this.refresh();
        },
        "$route.query.section"(value) {
            if (this.visibleTabs.includes(value)) this.section = value;
        },
        "$root.username"() {
            this.generation++;
            this.projects = [];
            this.snapshot = null;
            this.refreshing = false;
            this.loadProjects();
        },
        section(value) {
            if (value === "audit") {
                this.loadAudit();
            }
        },
    },
    mounted() {
        this.loadProjects();
        this.clock = setInterval(() => this.refresh(), 5000);
    },
    beforeUnmount() {
        this.generation++;
        clearInterval(this.clock);
    },
    methods: {
        /**
         * @param {number} monitorID Saved owned check
         * @returns {void} Open the repair view even when the route already matches
         */
        openCodeRecovery(monitorID) {
            if (this.snapshot?.monitors.some((monitor) => monitor.id === monitorID)) this.monitorID = monitorID;
            this.section = "recovery";
        },
        /**
         * @param {object} monitor Scoped saved evidence
         * @returns {string} Fixed status label
         */
        checkStateLabel(monitor) {
            return (
                (monitor.state === "maintenance" && workLabel(monitor.observations.at(-1))) ||
                `projectCurrent_${monitor.state}`
            );
        },
        /** @returns {Promise<void>} List names only from current memberships */
        async loadProjects() {
            if (!this.$root.loggedIn || !this.$root.socket.connected) {
                return;
            }
            const generation = this.generation;
            this.loading = true;
            try {
                const result = await projectRequest(this.$root, "projectList");
                if (generation !== this.generation) {
                    return;
                }
                this.projects = result.projects;
                if (!this.selectedID && this.projects.length) {
                    await this.$router.replace(`/projects/${this.projects[0].id}`);
                } else {
                    await this.refresh();
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                    this.snapshot = null;
                }
            } finally {
                if (generation === this.generation) {
                    this.loading = false;
                }
            }
        },
        /** @returns {Promise<void>} Fresh permitted snapshots; never retain revoked data */
        async refresh() {
            if (
                !this.selectedID ||
                !this.$root.loggedIn ||
                !this.$root.socket.connected ||
                this.refreshing ||
                this.busy
            ) {
                return;
            }
            const generation = this.generation;
            this.refreshing = true;
            try {
                const result = await projectRequest(this.$root, "projectSnapshot", { projectID: this.selectedID });
                if (generation !== this.generation) {
                    return;
                }
                const firstSnapshot = !this.snapshot;
                this.snapshot = result;
                this.blocked = false;
                this.error = "";
                if (!this.visibleTabs.includes(this.section)) {
                    this.section = "checks";
                }
                if (firstSnapshot && this.visibleTabs.includes(this.$route.query.section)) {
                    this.section = this.$route.query.section;
                }
                if (!this.editName || !this.renaming) {
                    this.editName = result.project.name;
                    this.editZone = result.project.timezone;
                    this.editIPs = (result.project.allowedIPs || []).join(", ");
                }
                if (!this.monitorID && result.monitors.length) {
                    const requested = Number(this.$route.query.check);
                    this.monitorID = (
                        result.monitors.find((monitor) => monitor.id === requested) || result.monitors[0]
                    ).id;
                    this.reportMonitorID = this.monitorID;
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                    if (["projectAccessDenied", "projectAuthRequired"].includes(error.message)) {
                        this.snapshot = null;
                        this.summary = null;
                        this.events = [];
                        this.editorOpen = false;
                        this.blocked = true;
                    }
                }
            } finally {
                if (generation === this.generation) {
                    this.refreshing = false;
                }
            }
        },
        /**
         * @param {string|number} projectID Selected ID
         * @returns {void} Route holds the chosen project
         */
        select(projectID) {
            this.$router.push(`/projects/${projectID}`);
        },
        /**
         * @param {string} event Mutation
         * @param {object} data Payload
         * @returns {Promise<object|null>} Authorized response
         */
        async act(event, data) {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                const result = await projectRequest(this.$root, event, data);
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
        /** @returns {Promise<void>} A new isolated data owner, not a copy of another project */
        async create() {
            const result = await this.act("projectCreate", {
                name: this.newName,
                timezone: this.newZone,
                allowedIPs: this.newIPs
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean),
            });
            if (result) {
                this.creating = false;
                this.newName = "";
                this.newIPs = "";
                await this.loadProjects();
                await this.$router.push(`/projects/${result.id}`);
            }
        },
        /** @returns {Promise<void>} Save project metadata with current revision */
        async rename() {
            const result = await this.act("projectUpdate", {
                projectID: this.selectedID,
                revision: this.snapshot.project.revision,
                name: this.editName,
                timezone: this.editZone,
                ...(this.$root.projectAccess.installationAdmin
                    ? {
                          allowedIPs: this.editIPs
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean),
                      }
                    : {}),
            });
            if (result) {
                this.renaming = false;
                await this.loadProjects();
            }
        },
        /**
         * @param {number|null} monitorID Existing check
         * @returns {void} Open an explicit editor
         */
        openEditor(monitorID) {
            this.editorID = monitorID;
            this.editorOpen = true;
        },
        /**
         * @param {number} monitorID Saved check
         * @returns {Promise<void>} Show only saved data
         */
        async savedMonitor(monitorID) {
            this.editorOpen = false;
            this.monitorID = monitorID;
            await this.refresh();
        },
        /**
         * @param {object} monitor Check
         * @returns {Promise<void>} Existing monitoring lifecycle
         */
        async control(monitor) {
            const result = await this.act("projectControlMonitor", {
                projectID: this.selectedID,
                id: monitor.id,
                action: monitor.active ? "pause" : "resume",
            });
            if (result) {
                await this.refresh();
            }
        },
        /** @returns {Promise<void>} Reuse the retained-history calculation including gaps */
        async report() {
            const result = await this.act("projectPeriodSummary", {
                projectID: this.selectedID,
                monitorID: this.reportMonitorID,
                start: this.reportStart + ":00.000Z",
                end: this.reportEnd + ":00.000Z",
            });
            if (result) {
                this.summary = result.summary;
            }
        },
        /** @returns {Promise<void>} Safe bounded audit feed */
        async loadAudit() {
            const result = await this.act("projectAudit", { projectID: this.selectedID });
            if (result) {
                this.events = result.events;
            }
        },
        /**
         * @param {number|null} value Actual measured proportion
         * @returns {string} Unknown stays unknown
         */
        percent(value) {
            return value === null
                ? "—"
                : new Intl.NumberFormat(this.$i18n.locale, { style: "percent", maximumFractionDigits: 2 }).format(
                      value
                  );
        },
        /**
         * @param {number} value UTC milliseconds
         * @returns {string} Project-local date
         */
        formatTime(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, {
                dateStyle: "short",
                timeStyle: "short",
                timeZone: this.snapshot.project.timezone,
            }).format(new Date(Number(value)));
        },
    },
};
</script>
