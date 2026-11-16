<template>
    <form class="ws-alert-wizard my-4" @submit.prevent="save(true)">
        <div class="ws-wizard-heading">
            <div>
                <h3>{{ $t("criticalAlertTitle") }}</h3>
                <p class="ws-channel-note mb-0">{{ $t("criticalAlertHelp") }}</p>
            </div>
        </div>
        <div class="ws-wizard-fields">
            <label>
                {{ $t("workspaceService") }}
                <select v-model.number="monitorID" class="form-select" required :disabled="busy" @change="selectRule">
                    <option :value="null" disabled>{{ $t("criticalAlertChooseMonitor") }}</option>
                    <option v-for="monitor in checks" :key="monitor.id" :value="monitor.id">{{ monitor.name }}</option>
                </select>
            </label>
            <label>
                Telegram
                <select v-model.number="telegramID" class="form-select" required :disabled="busy || !monitorID">
                    <option :value="null" disabled>{{ $t("stage2Channel") }}</option>
                    <option v-for="channel in primaryChannels" :key="channel.id" :value="channel.id">
                        {{ channel.name }}
                    </option>
                </select>
            </label>
            <label>
                {{ $t("criticalAlertEmail") }}
                <select v-model.number="emailID" class="form-select" required :disabled="busy || !monitorID">
                    <option :value="null" disabled>{{ $t("stage2Channel") }}</option>
                    <option v-for="channel in backupChannels" :key="channel.id" :value="channel.id">
                        {{ channel.name }}
                    </option>
                </select>
            </label>
        </div>
        <p v-if="error" role="alert" class="ws-form-error">{{ $t(error) }}</p>
        <p v-else-if="message" role="status" class="ws-channel-note">{{ $t(message) }}</p>
        <div class="ws-wizard-buttons">
            <button class="ws-button ws-button-primary" :disabled="busy || !monitorID || !telegramID || !emailID">
                {{ $t("Save") }}
            </button>
            <button v-if="rule" type="button" class="ws-button ws-button-quiet" :disabled="busy" @click="save(false)">
                {{ $t("Disable") }}
            </button>
        </div>
    </form>
</template>

<script>
export default {
    props: {
        channels: { type: Array, required: true },
        monitors: { type: Array, required: true },
        requester: { type: Function, required: true },
    },
    data() {
        return { monitorID: null, telegramID: null, emailID: null, rules: [], busy: false, error: "", message: "" };
    },
    computed: {
        checks() {
            return this.monitors.filter((monitor) => monitor.type !== "group");
        },
        rule() {
            return this.rules.find((item) => item.monitorID === this.monitorID);
        },
        primaryChannels() {
            return this.channels.filter(
                (item) => item.managed && item.type === "telegram" && item.monitorIDs.includes(this.monitorID)
            );
        },
        backupChannels() {
            return this.channels.filter(
                (item) => item.managed && item.type === "smtp" && !item.monitorIDs.includes(this.monitorID)
            );
        },
    },
    async mounted() {
        this.busy = true;
        try {
            this.rules = (await this.requester("getAlertRules")).rules;
        } catch (error) {
            this.error = error.message;
        } finally {
            this.busy = false;
        }
    },
    methods: {
        /** @returns {void} Populate the form for the selected monitor. */
        selectRule() {
            this.telegramID = this.rule?.telegramID ?? null;
            this.emailID = this.rule?.emailID ?? null;
            this.error = "";
            this.message = "";
        },
        /**
         * @param {boolean} enabled New rule state
         * @returns {Promise<void>} Update the rule and persisted form state
         */
        async save(enabled) {
            this.busy = true;
            this.error = "";
            this.message = "";
            try {
                await this.requester("saveAlertRule", {
                    enabled,
                    monitorID: this.monitorID,
                    telegramID: this.telegramID,
                    emailID: this.emailID,
                });
                this.rules = (await this.requester("getAlertRules")).rules;
                this.selectRule();
                this.message = enabled ? "criticalAlertSaved" : "criticalAlertDisabled";
            } catch (error) {
                this.error = error.message;
            } finally {
                this.busy = false;
            }
        },
    },
};
</script>
