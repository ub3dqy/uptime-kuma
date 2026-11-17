<template>
    <section
        class="workspace-overview pm-overview"
        :data-testid="servicesPage ? 'workspace-services' : 'workspace-overview'"
    >
        <div class="pm-hero-composition">
            <div class="ws-heading-row pm-hero-heading">
                <div>
                    <p class="ws-eyebrow">
                        <span class="ws-connection-dot" :class="{ offline: !$root.socket.connected }" />
                        {{ $t($root.socket.connected ? "workspaceConnected" : "workspaceDisconnected") }}
                    </p>
                    <h1>{{ $t(servicesPage ? "workspaceServicesTitle" : "workspaceOverviewTitle") }}</h1>
                    <p class="ws-subtitle">
                        {{ $t(servicesPage ? "workspaceServicesHelp" : "workspaceOverviewSubtitle") }}
                    </p>
                </div>
                <div class="ws-heading-actions">
                    <router-link to="/add" class="ws-button ws-button-primary">
                        <WorkspaceIcon name="plus" />
                        {{ $t("workspaceAddService") }}
                    </router-link>
                </div>
            </div>

            <div class="ws-summary pm-hero-summary">
                <div class="ws-summary-counts" :aria-label="$t('workspaceLatestStates')">
                    <button
                        v-for="metric in metrics"
                        :key="metric.key"
                        type="button"
                        class="ws-metric"
                        :class="`ws-metric-${metric.key}`"
                        :disabled="!$root.monitorListLoaded"
                        @click="setFilter(metric.filter)"
                    >
                        <WorkspaceIcon :name="metric.icon" />
                        <ObservedNumber v-if="$root.monitorListLoaded" class="ws-metric-number" :value="metric.count" />
                        <span v-else class="ws-metric-number">—</span>
                        <span class="ws-metric-label">{{ $t(metric.label) }}</span>
                    </button>
                </div>
            </div>
            <MonitoringLens :connected="$root.socket.connected" />
        </div>

        <div v-if="attentionCount" class="ws-attention" role="status">
            <WorkspaceIcon name="warning" />
            <div>
                <strong>{{ $t("workspaceAttentionCount", { count: attentionCount }) }}</strong>
                <p>{{ $t("workspaceAttentionHelp") }}</p>
            </div>
            <button type="button" class="ws-button ws-button-quiet" @click="setFilter('attention')">
                {{ $t("workspaceViewIssues") }}
                <WorkspaceIcon name="arrow" />
            </button>
        </div>

        <div v-if="$slots.actions" class="pm-list-actions"><slot name="actions" /></div>
        <div class="ws-controls">
            <label class="ws-scope">
                <span class="visually-hidden">{{ $t("workspaceScope") }}</span>
                <select v-model="scope" class="form-select" :aria-label="$t('workspaceScope')" @change="updateScope">
                    <option value="all">{{ $t("workspaceAllServices") }}</option>
                    <option v-for="group in groups" :key="group.id" :value="String(group.id)">{{ group.name }}</option>
                </select>
            </label>
            <div class="ws-filters" role="group" :aria-label="$t('workspaceFilter')">
                <button
                    v-for="filter in filters"
                    :key="filter.key"
                    type="button"
                    :aria-pressed="statusFilter === filter.key"
                    :class="{ selected: statusFilter === filter.key }"
                    @click="setFilter(filter.key)"
                >
                    {{ $t(filter.label) }}
                </button>
            </div>
            <label class="ws-search">
                <WorkspaceIcon name="search" />
                <span class="visually-hidden">{{ $t("workspaceSearch") }}</span>
                <input v-model="search" type="search" :placeholder="$t('workspaceSearch')" />
            </label>
        </div>
        <p v-if="groupError" class="ws-inline-note" role="status">
            {{ $t("workspaceGroupsUnavailable") }}
            <button type="button" class="ws-text-button" @click="loadGroups">{{ $t("Retry") }}</button>
        </p>
        <label v-if="demoCount" class="ws-demo-toggle">
            <input v-model="includeDemo" type="checkbox" />
            {{ $t("workspaceShowDemo", { count: demoCount }) }}
        </label>

        <p v-if="!$root.monitorListLoaded" class="pm-list-loading" role="status">
            <span class="pm-progress-orbit" />
            {{ $t("premiumServicesLoading") }}
        </p>
        <div v-else class="ws-service-list" data-testid="monitor-list">
            <div class="ws-list-head" aria-hidden="true">
                <span />
                <span>{{ $t("workspaceService") }}</span>
                <span>{{ $t("Status") }}</span>
                <span>{{ $t("workspaceObservations") }}</span>
                <span>{{ $t("workspaceResponse") }}</span>
                <span />
            </div>
            <ul v-if="visibleServices.length" class="ws-service-items">
                <li v-for="row in visibleServices" :key="row.monitor.id">
                    <div class="ws-service-row" :data-testid="`service-row-${row.monitor.id}`">
                        <button
                            class="pm-service-disclosure"
                            type="button"
                            :aria-expanded="expandedMonitor === row.monitor.id"
                            :aria-controls="`service-observations-${row.monitor.id}`"
                            :aria-label="$t('premiumExpandService', { name: row.name })"
                            @click="expandedMonitor = expandedMonitor === row.monitor.id ? null : row.monitor.id"
                        >
                            <WorkspaceIcon name="arrow" />
                        </button>
                        <router-link :to="`/dashboard/${row.monitor.id}`" class="ws-service-identity pm-service-link">
                            <span class="ws-service-avatar" :class="`tone-${row.monitor.id % 5}`">
                                {{ Array.from(row.name)[0].toUpperCase() }}
                            </span>
                            <span class="ws-service-name">
                                <strong>{{ row.name }}</strong>
                                <small>{{ row.host || $t("workspacePrivateService") }}</small>
                            </span>
                        </router-link>
                        <div class="ws-service-status">
                            <span class="ws-state" :class="`ws-state-${row.state}`">
                                <span />
                                {{ $t(row.workLabel || stateLabels[row.state]) }}
                            </span>
                            <small v-if="row.state === 'down' || row.state === 'pending' || row.state === 'unknown'">
                                {{ $t(row.explanation) }}
                            </small>
                        </div>
                        <ObservationTrace
                            :monitor-id="row.monitor.id"
                            :name="row.name"
                            :observations="$root.heartbeatList[row.monitor.id] || []"
                            :now="now"
                        />
                        <span class="ws-response">{{ responseText(row) }}</span>
                        <span class="pm-service-row-arrow" aria-hidden="true">
                            <WorkspaceIcon name="arrow" class="ws-row-arrow" />
                        </span>
                    </div>
                    <div
                        v-if="expandedMonitor === row.monitor.id"
                        :id="`service-observations-${row.monitor.id}`"
                        class="pm-service-expanded"
                        role="region"
                        :aria-label="$t('premiumServiceObservations', { name: row.name })"
                    >
                        <ObservationChart
                            :key="row.monitor.id"
                            :monitor-id="row.monitor.id"
                            :name="row.name"
                            :observations="$root.heartbeatList[row.monitor.id] || []"
                            :now="now"
                        />
                        <router-link :to="`/dashboard/${row.monitor.id}`" class="ws-button ws-button-quiet">
                            {{ $t("premiumOpenIncident") }}
                            <WorkspaceIcon name="arrow" />
                        </router-link>
                    </div>
                </li>
            </ul>
            <div v-else class="ws-empty">
                <WorkspaceIcon :name="services.length ? 'search' : 'activity'" />
                <h2>{{ $t(services.length ? "workspaceNoMatches" : "workspaceNoServices") }}</h2>
                <p>{{ $t(services.length ? "workspaceTryFilter" : "workspaceStartHelp") }}</p>
                <button v-if="services.length" type="button" class="ws-button ws-button-quiet" @click="resetFilters">
                    {{ $t("workspaceResetFilters") }}
                </button>
                <router-link v-else to="/start" class="ws-button ws-button-primary">
                    {{ $t("startTitle") }}
                </router-link>
            </div>
        </div>
        <button
            v-if="filteredServices.length > visibleServices.length"
            type="button"
            class="ws-button ws-button-quiet ws-load-more"
            @click="visibleLimit += 50"
        >
            {{ $t("workspaceShowMore") }}
        </button>
        <div class="ws-list-foot">
            <div v-if="visibleServices.length">
                <ul class="pm-trace-legend" :aria-label="$t('workspaceObservations')">
                    <li v-for="item in traceLegend" :key="item.tone">
                        <i :class="`pm-trace-key-${item.tone}`" aria-hidden="true" />
                        {{ $t(item.label) }}
                    </li>
                </ul>
                <p class="pm-trace-hint">{{ $t("premiumTraceHint") }}</p>
            </div>
            <router-link to="/events">
                {{ $t("workspaceEventHistory") }}
                <WorkspaceIcon name="arrow" />
            </router-link>
        </div>

        <slot name="management" />
        <div class="pm-capability-strip">
            <router-link to="/projects" class="pm-capability-link">
                <WorkspaceIcon name="sparkles" />
                <span>
                    <strong>{{ $t("premiumPersonalAI") }}</strong>
                    <small>{{ $t("premiumPersonalAIHelp") }}</small>
                </span>
                <WorkspaceIcon name="arrow" />
            </router-link>
            <router-link to="/notifications" class="pm-capability-link">
                <WorkspaceIcon name="alerts" />
                <span>
                    <strong>
                        {{ $t($root.notificationList.length ? "premiumCheckAlerts" : "workspaceConnectAlerts") }}
                    </strong>
                    <small>{{ $t("premiumCheckAlertsHelp") }}</small>
                </span>
                <WorkspaceIcon name="arrow" />
            </router-link>
        </div>
    </section>
</template>

<script>
import WorkspaceIcon from "../components/WorkspaceIcon.vue";
import MonitoringLens from "../components/MonitoringLens.vue";
import ObservedNumber from "../components/ObservedNumber.vue";
import ObservationChart from "../components/ObservationChart.vue";
import ObservationTrace from "../components/ObservationTrace.vue";
import { workLabel } from "../site-work.ts";
import { currentServiceState, isBuiltInDemo, issueExplanation, serviceHost } from "../overview-state.ts";

export default {
    components: { WorkspaceIcon, MonitoringLens, ObservedNumber, ObservationChart, ObservationTrace },
    props: {
        servicesPage: { type: Boolean, default: false },
    },
    data() {
        return {
            now: Date.now(),
            clock: null,
            groups: [],
            groupError: false,
            scope: "all",
            scopeRequest: 0,
            search: "",
            statusFilter: "all",
            includeDemo: false,
            visibleLimit: 50,
            expandedMonitor: null,
            traceLegend: [
                { tone: "line", label: "premiumTraceResponse" },
                { tone: "up", label: "workspaceStateWorking" },
                { tone: "down", label: "premiumTraceFailure" },
                { tone: "pending", label: "workspaceStatePending" },
                { tone: "maintenance", label: "workspaceStateMaintenance" },
                { tone: "gap", label: "premiumTraceGap" },
            ],
            stateLabels: {
                up: "workspaceStateWorking",
                down: "workspaceStateDown",
                pending: "workspaceStatePending",
                unknown: "workspaceStateUnknown",
                paused: "workspaceStatePaused",
                maintenance: "workspaceStateMaintenance",
            },
            filters: [
                { key: "all", label: "workspaceAll" },
                { key: "up", label: "workspaceStateUp" },
                { key: "attention", label: "workspaceProblems" },
                { key: "unknown", label: "workspaceStateUnknown" },
                { key: "paused", label: "workspacePauseFilter" },
            ],
        };
    },
    computed: {
        monitors() {
            return Object.values(this.$root.monitorList).filter((monitor) => monitor.type !== "group");
        },
        demoCount() {
            return this.monitors.filter(isBuiltInDemo).length;
        },
        services() {
            const group = this.groups.find((group) => String(group.id) === this.scope);
            const now = Math.max(this.now, Date.now());
            return this.monitors
                .filter(
                    (monitor) =>
                        (this.includeDemo || !isBuiltInDemo(monitor)) &&
                        (!group || group.monitorIDs.includes(monitor.id))
                )
                .map((monitor) => {
                    const beats = this.$root.heartbeatList[monitor.id] || [];
                    const status = currentServiceState(monitor, beats, now, this.$root.socket.connected);
                    const name =
                        monitor.name?.startsWith("Sites/") && monitor.name.length > 6
                            ? monitor.name.slice(6)
                            : monitor.name;
                    return {
                        monitor,
                        ...status,
                        workLabel: status.state === "maintenance" ? workLabel(status.latest) : null,
                        name: name || this.$t("workspaceUnnamed"),
                        host: serviceHost(monitor),
                        explanation: issueExplanation(status.state, status.latest?.msg),
                    };
                })
                .sort((a, b) => a.name.localeCompare(b.name, this.$i18n.locale));
        },
        attentionCount() {
            return this.services.filter((row) => ["down", "pending"].includes(row.state)).length;
        },
        metrics() {
            return [
                {
                    key: "up",
                    label: "workspaceStateUp",
                    icon: "check",
                    filter: "up",
                    count: this.services.filter((row) => row.state === "up").length,
                },
                {
                    key: "attention",
                    label: "workspaceAttention",
                    icon: "warning",
                    filter: "attention",
                    count: this.attentionCount,
                },
                {
                    key: "unknown",
                    label: "workspaceStateUnknown",
                    icon: "unknown",
                    filter: "unknown",
                    count: this.services.filter((row) => row.state === "unknown").length,
                },
                {
                    key: "paused",
                    label: "workspacePauseFilter",
                    icon: "pause",
                    filter: "paused",
                    count: this.services.filter((row) => ["paused", "maintenance"].includes(row.state)).length,
                },
            ];
        },
        filteredServices() {
            const query = this.search.trim().toLocaleLowerCase();
            return this.services.filter(
                (row) =>
                    (!query || `${row.name} ${row.host}`.toLocaleLowerCase().includes(query)) &&
                    (this.statusFilter === "all" ||
                        row.state === this.statusFilter ||
                        (this.statusFilter === "attention" && ["down", "pending"].includes(row.state)) ||
                        (this.statusFilter === "paused" && row.state === "maintenance"))
            );
        },
        visibleServices() {
            return this.filteredServices.slice(0, this.visibleLimit);
        },
    },
    watch: {
        "$root.socket.connected"(connected) {
            if (connected) {
                this.loadGroups();
            }
        },
        search() {
            this.visibleLimit = 50;
        },
    },
    mounted() {
        this.clock = setInterval(() => {
            this.now = Date.now();
        }, 10000);
        this.loadGroups();
    },
    beforeUnmount() {
        clearInterval(this.clock);
        this.scopeRequest++;
    },
    methods: {
        /**
         * Load the signed-in owner's groups; discard replies after logout or navigation.
         * @returns {void}
         */
        loadGroups() {
            if (!this.$root.socket.connected || !this.$root.loggedIn) {
                return;
            }
            const request = ++this.scopeRequest;
            const owner = this.$root.username;
            this.groupError = false;
            this.$root
                .getSocket()
                .timeout(10000)
                .emit("listClientGroups", {}, (error, result) => {
                    if (request !== this.scopeRequest || !this.$root.loggedIn || owner !== this.$root.username) {
                        return;
                    }
                    if (error || !result?.ok) {
                        this.groupError = true;
                        return;
                    }
                    this.groups = result.clients;
                    const desired = this.$route.query.client;
                    this.scope =
                        typeof desired === "string" && this.groups.some((group) => String(group.id) === desired)
                            ? desired
                            : "all";
                });
        },
        /**
         * Keep the authorized view bookmarkable without persisting account data.
         * @returns {void}
         */
        updateScope() {
            const query = { ...this.$route.query };
            if (this.scope === "all") {
                delete query.client;
            } else {
                query.client = this.scope;
            }
            this.$router.replace({ path: this.$route.path, query });
            this.visibleLimit = 50;
        },
        /**
         * Filter buttons remain local and never pause or change a monitor.
         * @param {string} filter Display state to select
         * @returns {void}
         */
        setFilter(filter) {
            this.statusFilter = filter;
            this.search = "";
            this.visibleLimit = 50;
        },
        /**
         * Reset search and state while retaining the explicitly chosen group.
         * @returns {void}
         */
        resetFilters() {
            this.setFilter("all");
        },
        /**
         * Zero milliseconds is valid; missing and failed values stay unknown.
         * @param {object} row Current service state and evidence
         * @returns {string} Localized measurement or an unknown marker
         */
        responseText(row) {
            const ping = row.latest?.ping;
            return row.state === "up" && typeof ping === "number" && Number.isFinite(ping) && ping >= 0
                ? this.$t("workspaceMilliseconds", {
                      value: new Intl.NumberFormat(this.$i18n.locale, { maximumFractionDigits: 1 }).format(ping),
                  })
                : "—";
        },
    },
};
</script>
