<template>
    <section v-if="$root.projectAccess.installationAdmin" class="ws-start" data-testid="getting-started">
        <h1>{{ $t("startTitle") }}</h1>
        <nav class="ws-start-steps" :aria-label="$t('startTitle')">
            <router-link
                v-for="item in steps"
                :key="item.id"
                :to="stepLink(item.id)"
                class="ws-button ws-button-quiet"
                :aria-current="step === item.id ? 'step' : undefined"
            >
                {{ $t(item.label) }}
            </router-link>
        </nav>

        <section v-if="step === 'site'" class="ws-project-panel" aria-labelledby="start-site-title">
            <h2 id="start-site-title">{{ $t("startSiteTitle") }}</h2>
            <p class="ws-channel-note">{{ $t("startSiteHelp") }}</p>
            <form class="ws-start-site" :aria-busy="saving" @submit.prevent="create">
                <label for="first-website">{{ $t("startSiteAddress") }}</label>
                <input
                    id="first-website"
                    ref="site"
                    v-model.trim="address"
                    class="form-control"
                    type="text"
                    name="website"
                    inputmode="url"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="$t('startSiteExample')"
                    maxlength="2048"
                    required
                />
                <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
                <button type="submit" class="ws-button ws-button-primary" :disabled="saving">
                    {{ $t(saving ? "startAdding" : "startAddSite") }}
                </button>
            </form>
            <p v-if="createdMonitor" class="ws-test-state mt-3" role="status">
                {{ $t("startSiteAdded") }}
                <router-link :to="'/dashboard/' + createdMonitor">{{ $t("startViewSite") }}</router-link>
            </p>
            <div class="ws-wizard-buttons mt-3">
                <router-link :to="stepLink('alerts')" class="ws-button ws-button-quiet">
                    {{ $t("startNextAlerts") }}
                </router-link>
                <router-link to="/add" class="ws-button ws-button-quiet">{{ $t("startOtherCheck") }}</router-link>
            </div>
        </section>

        <section v-else-if="step === 'alerts'" aria-labelledby="start-alerts-title">
            <h2 id="start-alerts-title">{{ $t("startAlertsTitle") }}</h2>
            <p class="ws-channel-note">{{ $t("startAlertsHelp") }}</p>
            <NotificationChannels />
            <div class="ws-wizard-buttons mt-3">
                <router-link :to="stepLink('ai')" class="ws-button ws-button-primary">
                    {{ $t("startNextAI") }}
                </router-link>
            </div>
        </section>

        <section v-else-if="step === 'ai'" aria-labelledby="start-ai-title">
            <h2 id="start-ai-title">{{ $t("startAITitle") }}</h2>
            <p class="ws-channel-note">{{ $t("startAIHelp") }}</p>
            <ProjectAI v-if="personalProject" :project-id="personalProject" role="admin" guided />
            <p v-else-if="loadingProject" role="status">{{ $t("startLoading") }}</p>
            <p v-else class="ws-channel-note">
                <router-link to="/projects">{{ $t("startOpenProjects") }}</router-link>
            </p>
            <div class="ws-wizard-buttons mt-3">
                <router-link :to="stepLink('protect')" class="ws-button ws-button-primary">
                    {{ $t("startNextProtection") }}
                </router-link>
            </div>
        </section>

        <section v-else class="ws-project-panel" aria-labelledby="start-security-title">
            <h2 id="start-security-title">{{ $t("startProtectionTitle") }}</h2>
            <p class="ws-channel-note">{{ $t("startProtectionHelp") }}</p>
            <div class="ws-wizard-buttons">
                <router-link to="/settings/security" class="ws-button ws-button-quiet">
                    {{ $t("startOpenSecurity") }}
                </router-link>
                <router-link to="/dashboard" class="ws-button ws-button-primary">{{ $t("startFinish") }}</router-link>
            </div>
        </section>
    </section>
</template>

<script>
import { defineAsyncComponent } from "vue";
import { projectRequest } from "../project-workflow";

const NotificationChannels = defineAsyncComponent(() => import("../components/NotificationChannels.vue"));
const ProjectAI = defineAsyncComponent(() => import("../components/ProjectAI.vue"));

export default {
    components: { NotificationChannels, ProjectAI },
    data() {
        return {
            steps: [
                { id: "site", label: "startStepSite" },
                { id: "alerts", label: "startStepAlerts" },
                { id: "ai", label: "startStepAI" },
                { id: "protect", label: "startStepProtection" },
            ],
            address: "",
            createdMonitor: null,
            error: "",
            saving: false,
            personalProject: null,
            loadingProject: false,
        };
    },
    computed: {
        step() {
            return this.steps.some(({ id }) => id === this.$route.query.step) ? this.$route.query.step : "site";
        },
        canLoadProject() {
            return (
                this.step === "ai" &&
                this.$root.loggedIn &&
                this.$root.projectAccess.installationAdmin &&
                this.$root.socket.connected
            );
        },
    },
    watch: {
        canLoadProject: {
            immediate: true,
            handler(active) {
                if (active && !this.personalProject) {
                    this.findPersonalProject();
                } else if (!this.$root.loggedIn) {
                    this.personalProject = null;
                }
            },
        },
    },
    methods: {
        /**
         * @param {string} step Wizard step
         * @returns {object} Link to the current step
         */
        stepLink(step) {
            return { path: "/start", query: { step } };
        },
        /** @returns {Promise<void>} Select only the active owner's personal project. */
        async findPersonalProject() {
            this.loadingProject = true;
            try {
                const { projects } = await projectRequest(this.$root, "projectList");
                this.personalProject =
                    projects.find((project) => project.personal && project.role === "admin")?.id || null;
            } catch {
                this.personalProject = null;
            } finally {
                this.loadingProject = false;
            }
        },
        /** @returns {Promise<void>} Use the normal monitor creation path with safe HTTP defaults. */
        async create() {
            if (this.saving) {
                return;
            }
            this.error = "";
            this.createdMonitor = null;
            let url;
            try {
                url = new URL(this.address.includes("://") ? this.address : "https://" + this.address);
                if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
                    throw new Error("Invalid site address");
                }
            } catch {
                this.error = "startAddressInvalid";
                this.$refs.site.focus();
                return;
            }

            this.saving = true;
            try {
                const previous = Object.values(this.$root.monitorList).find(
                    (monitor) => monitor.type === "http" && monitor.url === url.href
                );
                const created = previous
                    ? { monitorID: previous.id }
                    : await projectRequest(this.$root, "add", {
                          type: "http",
                          name: url.hostname,
                          url: url.href,
                          method: "GET",
                          active: true,
                          interval: 60,
                          retryInterval: 60,
                          timeout: 15,
                          maxretries: 1,
                          maxredirects: 10,
                          ignoreTls: false,
                          accepted_statuscodes: ["200-299"],
                          notificationIDList: {},
                          conditions: [],
                          rabbitmqNodes: [],
                          kafkaProducerBrokers: [],
                          kafkaProducerSaslOptions: {},
                      });
                this.createdMonitor = created.monitorID;
            } catch {
                this.error = "startSiteFailed";
            } finally {
                this.saving = false;
            }
        },
    },
};
</script>

<style scoped>
.ws-start {
    max-width: 860px;
    margin: 0 auto;
    padding-block: 1.5rem;
}
.ws-start h1,
.ws-start h2 {
    text-wrap: balance;
}
.ws-start-steps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block: 1rem 1.5rem;
}
.ws-start-steps [aria-current="step"] {
    color: var(--ws-action);
    background: var(--ws-action-soft);
    border-color: currentColor;
}
.ws-start-site {
    display: grid;
    gap: 0.75rem;
    max-width: 38rem;
}
.ws-start-site button {
    justify-self: start;
}
</style>
