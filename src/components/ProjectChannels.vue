<template>
    <section class="ws-project-panel" data-testid="project-channels">
        <h2>{{ $t("workspaceNavAlerts") }}</h2>
        <p class="ws-channel-note">{{ $t("projectChannelsHelp") }}</p>
        <p v-if="error" role="alert" class="ws-form-error">{{ $t(error) }}</p>
        <div v-if="canManage" class="ws-wizard-buttons">
            <button class="ws-button ws-button-primary" @click="open('smtp')">{{ $t("workspaceConnectEmail") }}</button>
            <button class="ws-button ws-button-quiet" @click="open('telegram')">
                {{ $t("workspaceConnectTelegram") }}
            </button>
        </div>
        <NotificationWizard
            v-if="wizard"
            :key="wizardKey"
            :type="wizard"
            :channel="editing"
            :available-monitors="monitors"
            :requester="requester"
            @close="wizard = null"
            @saved="load"
        />
        <p v-if="!channels.length" class="ws-channel-note">{{ $t("workspaceNoChannels") }}</p>
        <ul class="ws-project-member-list">
            <li v-for="channel in channels" :key="channel.id">
                <span>
                    <strong>{{ channel.name }}</strong>
                    <small class="d-block">{{ channel.type }}</small>
                </span>
                <button
                    v-if="canManage && channel.managed"
                    class="ws-button ws-button-quiet"
                    @click="open(channel.type, channel)"
                >
                    {{ $t("Edit") }}
                </button>
                <span v-else-if="canManage">{{ $t("projectLegacyChannel") }}</span>
            </li>
        </ul>
        <DeliveryHistory :key="historyKey" :delivery-request="deliveryRequest" />
    </section>
</template>
<script>
import NotificationWizard from "./NotificationWizard.vue";
import DeliveryHistory from "./DeliveryHistory.vue";
import { projectChannelRequest } from "../project-workflow";
export default {
    components: { NotificationWizard, DeliveryHistory },
    props: {
        projectId: { type: Number, required: true },
        monitors: { type: Array, required: true },
        canManage: { type: Boolean, default: false },
    },
    data() {
        return { channels: [], error: "", wizard: null, wizardKey: 0, historyKey: 0, editing: null, generation: 0 };
    },
    computed: {
        requester() {
            return projectChannelRequest(this.$root, this.projectId);
        },
        deliveryRequest() {
            return (data) => this.requester("getNotificationDelivery", data);
        },
    },
    watch: {
        canManage() {
            this.generation++;
            this.wizard = null;
            this.editing = null;
            this.channels = [];
            this.error = "";
            this.load();
        },
    },
    mounted() {
        this.load();
    },
    beforeUnmount() {
        this.generation++;
    },
    methods: {
        /** @returns {Promise<void>} Read only this project's permitted channel fields */
        async load() {
            const generation = this.generation;
            try {
                const result = await this.requester("getNotificationDelivery");
                if (generation === this.generation) {
                    this.channels = result.channels;
                    this.error = "";
                    this.historyKey++;
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
            }
        },
        /**
         * @param {string} type Type
         * @param {object|null} channel Settings
         * @returns {void} Explicit setup
         */
        open(type, channel = null) {
            this.editing = channel;
            this.wizardKey++;
            this.wizard = type;
        },
    },
};
</script>
