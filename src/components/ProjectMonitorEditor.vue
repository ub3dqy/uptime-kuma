<template>
    <section class="ws-alert-wizard" data-testid="project-monitor-editor">
        <div class="ws-wizard-heading">
            <h2>{{ $t(form.id ? "projectEditCheck" : "projectAddCheck") }}</h2>
            <button class="ws-button ws-button-quiet" :disabled="busy" @click="$emit('close')">
                {{ $t("Close") }}
            </button>
        </div>
        <MonitorPresets v-if="!form.id" @select="applyPreset" />
        <p class="ws-channel-note">{{ $t("projectNetworkHelp") }}</p>
        <p v-if="error" role="alert" class="ws-form-error">{{ $t(error) }}</p>
        <form @submit.prevent="save">
            <div class="ws-wizard-fields">
                <label>
                    {{ $t("Friendly Name") }}
                    <input v-model="form.name" class="form-control" required maxlength="120" />
                </label>
                <label>
                    {{ $t("Monitor Type") }}
                    <select v-model="form.type" class="form-select">
                        <option value="http">HTTP / HTTPS</option>
                        <option value="keyword">{{ $t("Keyword") }}</option>
                        <option value="json-query">JSON</option>
                        <option value="dns">DNS</option>
                        <option value="port">TCP</option>
                        <option value="push">{{ $t("stage2PresetBackup") }}</option>
                    </select>
                </label>
                <label v-if="isHTTP">
                    {{ $t("URL") }}
                    <input
                        v-model="form.url"
                        class="form-control"
                        type="url"
                        required
                        maxlength="2048"
                        placeholder="https://example.com/"
                    />
                </label>
                <label v-if="['dns', 'port'].includes(form.type)">
                    {{ $t("Hostname") }}
                    <input v-model="form.hostname" class="form-control" required maxlength="253" />
                </label>
                <label v-if="['dns', 'port'].includes(form.type)">
                    {{ $t("Port") }}
                    <input v-model.number="form.port" class="form-control" type="number" min="1" max="65535" required />
                </label>
                <label v-if="form.type === 'dns'">
                    {{ $t("projectDNSResolver") }}
                    <input v-model="form.dnsServer" class="form-control" required maxlength="253" />
                </label>
                <label v-if="form.type === 'keyword'">
                    {{ $t("Keyword") }}
                    <input v-model="form.keyword" class="form-control" required maxlength="500" />
                </label>
                <label v-if="form.type === 'json-query'">
                    {{ $t("Json Query") }}
                    <input v-model="form.jsonPath" class="form-control" required maxlength="500" />
                    <small>{{ $t("projectJSONPathHelp") }}</small>
                </label>
                <label v-if="form.type === 'json-query'">
                    {{ $t("Expected Value") }}
                    <input v-model="form.expectedValue" class="form-control" required maxlength="500" />
                </label>
                <label>
                    {{ $t("projectCheckInterval") }}
                    <input
                        v-model.number="form.interval"
                        class="form-control"
                        type="number"
                        min="20"
                        max="86400"
                        required
                    />
                </label>
                <label>
                    {{ $t("projectCheckRetries") }}
                    <input
                        v-model.number="form.maxretries"
                        class="form-control"
                        type="number"
                        min="0"
                        max="5"
                        required
                    />
                </label>
                <label v-if="isHTTP">
                    {{ $t("stage2MaximumResponse") }}
                    <input
                        v-model.number="form.max_response_time"
                        class="form-control"
                        type="number"
                        min="1"
                        max="3600000"
                        :placeholder="$t('stage2NoSpeedLimit')"
                    />
                </label>
            </div>
            <p v-if="form.type === 'push'" class="ws-channel-note">{{ $t("stage2BackupHonesty") }}</p>
            <p v-if="form.pushToken" class="ws-channel-note">
                {{ $t("projectPushSecretHelp") }}
                <input :value="pushURL" class="form-control" readonly :aria-label="$t('projectPushAddress')" />
            </p>
            <button type="submit" class="ws-button ws-button-primary" :disabled="busy">
                {{ $t(busy ? "stage2Saving" : "Save") }}
            </button>
        </form>
    </section>
</template>
<script>
import MonitorPresets from "./MonitorPresets.vue";
import { projectRequest } from "../project-workflow";
export default {
    components: { MonitorPresets },
    props: { projectId: { type: Number, required: true }, monitorId: { type: Number, default: null } },
    emits: ["saved", "close"],
    data() {
        return {
            busy: false,
            error: "",
            generation: 0,
            form: {
                name: "",
                type: "http",
                url: "",
                hostname: "",
                port: 443,
                dnsServer: "1.1.1.1",
                interval: 60,
                maxretries: 2,
                max_response_time: null,
                expiryNotification: true,
                keyword: "",
                jsonPath: "",
                expectedValue: "",
            },
        };
    },
    computed: {
        isHTTP() {
            return ["http", "keyword", "json-query"].includes(this.form.type);
        },
        pushURL() {
            return `${location.origin}/api/push/${this.form.pushToken}`;
        },
    },
    watch: {
        "form.type"(type) {
            if (!["http", "keyword", "json-query"].includes(type)) {
                this.form.max_response_time = null;
            }
        },
    },
    async mounted() {
        if (this.monitorId) {
            const generation = this.generation;
            this.busy = true;
            try {
                const result = await projectRequest(this.$root, "projectMonitorEditor", {
                    projectID: this.projectId,
                    id: this.monitorId,
                });
                if (generation === this.generation) {
                    Object.assign(this.form, result);
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
            } finally {
                if (generation === this.generation) {
                    this.busy = false;
                }
            }
        }
    },
    beforeUnmount() {
        this.generation++;
    },
    methods: {
        /**
         * @param {object} preset Choice
         * @returns {void} Preserve the actual target
         */
        applyPreset(preset) {
            Object.assign(this.form, preset);
            if (preset.type === "dns") {
                this.form.port = 53;
            }
        },
        /** @returns {Promise<void>} Explicitly save this project check */
        async save() {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                const result = await projectRequest(this.$root, "projectSaveMonitor", {
                    ...this.form,
                    projectID: this.projectId,
                    id: this.monitorId,
                });
                if (generation === this.generation) {
                    this.$emit("saved", result.id);
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
            } finally {
                if (generation === this.generation) {
                    this.busy = false;
                }
            }
        },
    },
};
</script>
