<template>
    <section class="pm-automation" data-testid="ai-automation">
        <div class="pm-ai-heading">
            <span class="pm-ai-emblem"><WorkspaceIcon name="activity" /></span>
            <div>
                <h3>{{ $t("premiumAutoDiagnosis") }}</h3>
                <p class="ws-channel-note">
                    {{
                        $t(
                            settings.active
                                ? "premiumAutoActive"
                                : settings.enabled
                                  ? "premiumAutoNeedsConsent"
                                  : "premiumAutoOff"
                        )
                    }}
                </p>
            </div>
        </div>
        <p>{{ $t("premiumAutoHelp") }}</p>
        <p v-if="settings.capacityExceeded" class="ws-channel-note">{{ $t("premiumTrackingTruncated") }}</p>
        <p class="ws-channel-note">{{ $t("premiumAutoLimits") }}</p>
        <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
        <p v-if="notice" role="status">{{ $t(notice) }}</p>
        <form v-if="loaded" @submit.prevent="save">
            <label class="ws-wizard-checkbox">
                <input v-model="enabled" type="checkbox" />
                {{ $t("premiumAutoEnable") }}
            </label>
            <fieldset class="pm-auto-monitors">
                <legend>{{ $t("premiumAutoChecks") }}</legend>
                <p class="ws-channel-note">{{ $t("premiumAutoChecksHelp") }}</p>
                <label v-for="monitor in settings.monitors || []" :key="monitor.id" class="ws-wizard-checkbox">
                    <input v-model="monitorIDs" type="checkbox" :value="monitor.id" />
                    <span>{{ monitor.name }}</span>
                </label>
                <p v-if="!settings.monitors?.length" class="ws-channel-note">{{ $t("premiumAutoNoChecks") }}</p>
            </fieldset>
            <label class="pm-auto-limit">
                {{ $t("premiumAutoDailyLimit") }}
                <input v-model.number="dailyLimit" type="number" min="1" max="50" required class="form-control" />
            </label>
            <label v-if="enabled" class="ws-wizard-checkbox">
                <input v-model="consent" type="checkbox" required />
                {{ $t("premiumAutoConsent") }}
            </label>
            <label class="pm-auto-password">
                {{ $t("Current Password") }}
                <input
                    v-model="password"
                    type="password"
                    autocomplete="current-password"
                    maxlength="1024"
                    class="form-control"
                    required
                />
            </label>
            <button
                type="submit"
                class="ws-button ws-button-primary"
                :disabled="busy || !password || (enabled && (!consent || !monitorIDs.length))"
            >
                {{ $t("premiumAutoSave") }}
            </button>
        </form>
    </section>
</template>
<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
import { projectRequest } from "../project-workflow";
export default {
    components: { WorkspaceIcon },
    props: { projectId: { type: Number, required: true } },
    data() {
        return {
            settings: {},
            loaded: false,
            enabled: false,
            dailyLimit: 3,
            consent: false,
            monitorIDs: [],
            password: "",
            busy: false,
            error: "",
            notice: "",
            generation: 0,
        };
    },
    watch: {
        projectId() {
            this.clear();
            this.load();
        },
        "$root.username"() {
            this.clear();
            this.load();
        },
        "$root.loggedIn"() {
            this.clear();
            this.load();
        },
        "$root.socket.connected"() {
            this.clear();
            this.load();
        },
    },
    mounted() {
        this.load();
    },
    beforeUnmount() {
        this.clear();
    },
    methods: {
        /** @returns {void} Discard password and consent when the identity or scope changes. */
        clear() {
            this.generation++;
            this.settings = {};
            this.loaded = false;
            this.password = "";
            this.consent = false;
            this.monitorIDs = [];
            this.error = "";
            this.notice = "";
            this.busy = false;
        },
        /** @returns {Promise<void>} Read policy without requesting inference. */
        async load() {
            if (!this.$root.loggedIn || !this.$root.socket.connected) return;
            const generation = this.generation;
            try {
                const { settings } = await projectRequest(this.$root, "projectAIAutomationGet", {
                    projectID: this.projectId,
                });
                if (generation !== this.generation) return;
                this.settings = settings;
                this.enabled = settings.enabled;
                this.dailyLimit = settings.dailyLimit;
                this.monitorIDs = settings.monitorIDs;
                this.loaded = true;
            } catch (error) {
                if (generation === this.generation) {
                    this.clear();
                    this.error = error.message;
                }
            }
        },
        /** @returns {Promise<void>} Separate explicit authorization for bounded future analysis. */
        async save() {
            if (this.busy) return;
            const generation = this.generation;
            const password = this.password;
            this.password = "";
            this.busy = true;
            this.error = "";
            this.notice = "";
            try {
                const { settings } = await projectRequest(this.$root, "projectAIAutomationSave", {
                    projectID: this.projectId,
                    revision: this.settings.revision,
                    enabled: this.enabled,
                    dailyLimit: this.dailyLimit,
                    monitorIDs: this.monitorIDs,
                    consent: this.consent,
                    currentPassword: password,
                });
                if (generation !== this.generation) return;
                this.settings = settings;
                this.consent = false;
                this.notice = "premiumAutoSaved";
            } catch (error) {
                if (generation === this.generation) {
                    this.consent = false;
                    this.error = error.message;
                    if (["projectAccessDenied", "projectAuthRequired"].includes(error.message)) this.loaded = false;
                }
            } finally {
                if (generation === this.generation) this.busy = false;
            }
        },
    },
};
</script>
