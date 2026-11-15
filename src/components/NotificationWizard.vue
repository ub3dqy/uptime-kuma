<template>
    <section class="ws-alert-wizard" data-testid="alert-wizard" aria-labelledby="alert-wizard-title">
        <div class="ws-wizard-heading">
            <h2 id="alert-wizard-title" ref="heading" tabindex="-1">
                {{ $t(type === "smtp" ? "workspaceConnectEmail" : "workspaceConnectTelegram") }}
            </h2>
            <button type="button" class="ws-button ws-button-quiet" :disabled="busy" @click="$emit('close')">
                {{ $t("Close") }}
            </button>
        </div>
        <ol class="ws-wizard-steps" :aria-label="$t('stage2SetupSteps')">
            <li
                v-for="(title, index) in stepLabels"
                :key="title"
                :class="{ active: step === index + 1 }"
                :aria-current="step === index + 1 ? 'step' : undefined"
            >
                <span>{{ index + 1 }}</span>
                {{ $t(title) }}
            </li>
        </ol>
        <div v-if="confirmingDelete" class="ws-form-error" role="alert">
            <p>{{ $t("stage2DeleteChannelWarning") }}</p>
            <div class="ws-wizard-buttons">
                <button
                    type="button"
                    class="ws-button ws-button-quiet"
                    :disabled="busy"
                    @click="confirmingDelete = false"
                >
                    {{ $t("Cancel") }}
                </button>
                <button type="button" class="ws-button ws-button-quiet" :disabled="busy" @click="remove">
                    {{ $t("stage2DeleteChannelConfirm") }}
                </button>
            </div>
        </div>
        <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
        <form v-if="step === 1" @submit.prevent="step = 2">
            <label>
                {{ $t("Friendly Name") }}
                <input v-model="form.name" class="form-control" required maxlength="120" autocomplete="off" />
            </label>
            <div v-if="type === 'smtp'" class="ws-wizard-fields">
                <label>
                    {{ $t("stage2MailServer") }}
                    <input
                        v-model="form.smtpHost"
                        class="form-control"
                        required
                        maxlength="253"
                        autocomplete="off"
                        placeholder="smtp.example.com"
                    />
                </label>
                <label>
                    {{ $t("stage2MailEncryption") }}
                    <select
                        v-model="form.smtpSecure"
                        class="form-select"
                        @change="form.smtpPort = form.smtpSecure ? 465 : 587"
                    >
                        <option :value="true">TLS · 465</option>
                        <option :value="false">STARTTLS · 587</option>
                    </select>
                </label>
                <label>
                    {{ $t("Port") }}
                    <input
                        v-model.number="form.smtpPort"
                        class="form-control"
                        type="number"
                        min="1"
                        max="65535"
                        required
                    />
                </label>
                <label>
                    {{ $t("Username") }}
                    <input v-model="form.smtpUsername" class="form-control" maxlength="254" autocomplete="off" />
                </label>
                <label>
                    {{ $t("Password") }}
                    <input
                        v-model="form.smtpPassword"
                        :aria-label="$t('Password')"
                        class="form-control"
                        type="password"
                        maxlength="1024"
                        autocomplete="new-password"
                        :placeholder="channel?.hasSecret ? $t('stage2KeepSecret') : ''"
                    />
                    <small>{{ $t("stage2SecretHelp") }}</small>
                </label>
                <label>
                    {{ $t("stage2MailFrom") }}
                    <input
                        v-model="form.smtpFrom"
                        class="form-control"
                        type="email"
                        maxlength="254"
                        required
                        autocomplete="off"
                    />
                </label>
                <label>
                    {{ $t("stage2MailTo") }}
                    <input
                        v-model="form.smtpTo"
                        class="form-control"
                        type="email"
                        maxlength="254"
                        required
                        autocomplete="off"
                    />
                </label>
            </div>
            <div v-else class="ws-wizard-fields">
                <label>
                    {{ $t("stage2TelegramToken") }}
                    <input
                        v-model="form.telegramBotToken"
                        class="form-control"
                        type="password"
                        maxlength="240"
                        :required="!channel?.hasSecret"
                        autocomplete="new-password"
                        :placeholder="channel?.hasSecret ? $t('stage2KeepSecret') : ''"
                    />
                </label>
                <label>
                    {{ $t("stage2TelegramChat") }}
                    <input
                        v-model="form.telegramChatID"
                        class="form-control"
                        required
                        maxlength="64"
                        autocomplete="off"
                        placeholder="-1001234567890"
                    />
                </label>
                <p class="ws-channel-note">{{ $t("stage2TelegramInstructions") }}</p>
            </div>
            <p class="ws-channel-note">{{ $t("stage2SecureChannels") }}</p>
            <button class="ws-button ws-button-primary" type="submit">
                {{ $t("stage2ChooseSites") }}
                <WorkspaceIcon name="arrow" />
            </button>
            <button
                v-if="channel"
                type="button"
                class="ws-button ws-button-quiet ms-3"
                :disabled="busy"
                @click="confirmingDelete = true"
            >
                {{ $t("Delete") }}
            </button>
        </form>
        <form v-else-if="step === 2" @submit.prevent="save">
            <h3>{{ $t("stage2AlertSelection") }}</h3>
            <p class="ws-channel-note">{{ $t("stage2AlertSelectionHelp") }}</p>
            <div class="ws-wizard-monitors">
                <label v-for="monitor in monitors" :key="monitor.id">
                    <input v-model="selected" type="checkbox" :value="monitor.id" />
                    {{ monitor.name }}
                </label>
            </div>
            <p v-if="!selected.length" class="ws-channel-note">{{ $t("stage2NoSelection") }}</p>
            <label class="ws-wizard-checkbox">
                <input v-model="form.isDefault" type="checkbox" />
                {{ $t("stage2DefaultForNew") }}
            </label>
            <div class="ws-wizard-buttons">
                <button class="ws-button ws-button-quiet" type="button" :disabled="busy" @click="step = 1">
                    {{ $t("stage2Back") }}
                </button>
                <button class="ws-button ws-button-primary" type="submit" :disabled="busy">
                    {{ $t(busy ? "stage2Saving" : "stage2SaveChannel") }}
                </button>
            </div>
        </form>
        <div v-else>
            <h3>{{ $t("stage2VerifyDelivery") }}</h3>
            <p>{{ $t("stage2VerifyDeliveryHelp") }}</p>
            <p v-if="latestTest" class="ws-test-state" data-testid="notification-test-state">
                {{ $t(label(latestTest)) }}
                <small v-if="latestTest.error_code">{{ $t(`stage2DeliveryError_${latestTest.error_code}`) }}</small>
            </p>
            <p v-else class="ws-test-state">{{ $t("stage2TestNotSent") }}</p>
            <div class="ws-wizard-buttons">
                <button
                    type="button"
                    class="ws-button ws-button-quiet"
                    :disabled="busy || testInFlight"
                    @click="sendTest"
                >
                    {{ $t("stage2SendTest") }}
                </button>
                <button
                    v-if="latestTest?.status === 'submitted' && !latestTest.confirmed_at"
                    type="button"
                    class="ws-button ws-button-primary"
                    :disabled="busy"
                    @click="confirm"
                >
                    {{ $t("stage2ConfirmReceived") }}
                </button>
                <button type="button" class="ws-button ws-button-primary" :disabled="busy" @click="$emit('close')">
                    {{ $t("stage2Done") }}
                </button>
            </div>
            <p class="ws-channel-note">{{ $t("stage2ConfirmationHelp") }}</p>
        </div>
    </section>
</template>
<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
import { workflowRequest, deliveryLabel } from "../notification-workflow";
export default {
    components: { WorkspaceIcon },
    props: {
        type: { type: String, required: true },
        channel: { type: Object, default: null },
        initialMonitor: { type: Number, default: null },
        availableMonitors: { type: Array, default: null },
        requester: { type: Function, default: null },
    },
    emits: ["close", "saved"],
    data() {
        return {
            step: 1,
            form: {},
            selected: [],
            saved: null,
            jobs: [],
            busy: false,
            refreshing: false,
            confirmingDelete: false,
            error: "",
            generation: 0,
            clock: null,
            stepLabels: ["stage2ChannelDetails", "stage2ChooseSites", "stage2VerifyDelivery"],
        };
    },
    computed: {
        monitors() {
            return (this.availableMonitors || Object.values(this.$root.monitorList)).filter(
                (monitor) => monitor.type !== "group"
            );
        },
        latestTest() {
            return this.jobs.find(
                (job) =>
                    job.kind === "test" &&
                    job.notification_id === this.saved?.id &&
                    job.revision === this.saved?.revision
            );
        },
        testInFlight() {
            return this.latestTest && ["queued", "sending"].includes(this.latestTest.status);
        },
    },
    mounted() {
        this.form = {
            type: this.type,
            name: this.channel?.name || (this.type === "smtp" ? this.$t("workspaceEmail") : "Telegram"),
            smtpHost: "",
            smtpPort: 465,
            smtpSecure: true,
            smtpUsername: "",
            smtpPassword: "",
            smtpFrom: "",
            smtpTo: "",
            telegramBotToken: "",
            telegramChatID: "",
            isDefault: this.channel?.isDefault || false,
            ...this.channel?.settings,
        };
        this.selected = this.channel
            ? [...this.channel.monitorIDs]
            : this.initialMonitor && this.monitors.some((monitor) => monitor.id === this.initialMonitor)
              ? [this.initialMonitor]
              : [];
        this.$refs.heading.focus();
        this.clock = setInterval(() => {
            if (this.saved && !this.busy) {
                this.refresh();
            }
        }, 3000);
    },
    beforeUnmount() {
        clearInterval(this.clock);
        this.generation++;
        this.form.smtpPassword = "";
        this.form.telegramBotToken = "";
    },
    methods: {
        label: deliveryLabel,
        /**
         * @param {string} event Operation
         * @param {object} payload Data
         * @returns {Promise<object>} Scoped workflow
         */
        request(event, payload = {}) {
            return this.requester ? this.requester(event, payload) : workflowRequest(this.$root, event, payload);
        },
        /** @returns {Promise<void>} Delete after the administrator explicitly confirms */
        async remove() {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                await this.request("deleteManagedNotification", {
                    id: this.channel.id,
                    revision: this.channel.revision,
                });
                if (generation === this.generation) {
                    this.$emit("saved");
                    this.$emit("close");
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
        /** @returns {Promise<void>} Refresh facts for the exact saved revision */
        async refresh() {
            if (this.refreshing || !this.$root.socket.connected) {
                return;
            }
            const generation = this.generation;
            this.refreshing = true;
            try {
                const result = await this.request("getNotificationDelivery");
                if (generation !== this.generation) {
                    return;
                }
                this.jobs = result.deliveries;
                if (
                    this.saved &&
                    result.channels.find((channel) => channel.id === this.saved.id)?.revision !== this.saved.revision
                ) {
                    this.error = "stage2ChannelChanged";
                }
            } catch {
                if (generation === this.generation) {
                    this.error = "stage2DeliveryUnavailable";
                }
            } finally {
                if (generation === this.generation) {
                    this.refreshing = false;
                }
            }
        },
        /** @returns {Promise<void>} Atomically save the channel and selected checks */
        async save() {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                const result = await this.request("saveManagedNotification", {
                    id: this.channel?.id ?? null,
                    revision: this.channel?.revision,
                    config: { ...this.form, locale: this.$i18n.locale },
                    monitorIDs: this.selected,
                });
                const overview = await this.request("getNotificationDelivery");
                if (generation !== this.generation) {
                    return;
                }
                this.saved = overview.channels.find((channel) => channel.id === result.id);
                if (!this.saved) {
                    throw new Error("stage2ChannelChanged");
                }
                this.jobs = overview.deliveries;
                this.form.smtpPassword = "";
                this.form.telegramBotToken = "";
                this.step = 3;
                this.$emit("saved");
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
        /** @returns {Promise<void>} Explicitly request a test to the saved recipient */
        async sendTest() {
            await this.act("testSavedNotification", { id: this.saved.id, revision: this.saved.revision });
        },
        /** @returns {Promise<void>} Record the administrator's explicit receipt confirmation */
        async confirm() {
            await this.act("confirmNotificationReceipt", { id: this.latestTest.id });
        },
        /**
         * @param {string} event Operation
         * @param {object} data Payload
         * @returns {Promise<void>} Action result
         */
        async act(event, data) {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                await this.request(event, data);
                if (generation === this.generation) {
                    await this.refresh();
                    this.$emit("saved");
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
