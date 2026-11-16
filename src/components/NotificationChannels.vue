<template>
    <section class="workspace-alerts-intro">
        <div class="ws-heading-row">
            <div>
                <p class="ws-eyebrow">{{ $t("workspaceNavAlerts") }}</p>
                <component :is="embedded ? 'h2' : 'h1'" class="ws-page-title">
                    {{ $t("workspaceNotificationTitle") }}
                </component>
                <p class="ws-subtitle">{{ $t("workspaceNotificationSubtitle") }}</p>
            </div>
        </div>
        <div class="ws-alert-choices">
            <article class="ws-channel-card">
                <WorkspaceIcon name="mail" />
                <h2>{{ $t("workspaceEmail") }}</h2>
                <p>{{ $t("workspaceEmailHelp") }}</p>
                <button type="button" class="ws-button ws-button-primary" @click="openWizard('smtp')">
                    {{ $t("workspaceConnectEmail") }}
                    <WorkspaceIcon name="arrow" />
                </button>
            </article>
            <article class="ws-channel-card">
                <WorkspaceIcon name="telegram" />
                <h2>Telegram</h2>
                <p>{{ $t("workspaceTelegramHelp") }}</p>
                <button type="button" class="ws-button ws-button-primary" @click="openWizard('telegram')">
                    {{ $t("workspaceConnectTelegram") }}
                    <WorkspaceIcon name="arrow" />
                </button>
            </article>
        </div>
        <NotificationWizard
            v-if="wizardType"
            :key="wizardKey"
            :type="wizardType"
            :channel="editingChannel"
            :initial-monitor="initialMonitor"
            @close="wizardType = null"
            @saved="refreshDelivery"
        />
        <p class="ws-channel-note">{{ $t("workspaceChannelHonesty") }}</p>
        <p v-if="deliveryError" role="status">{{ $t(deliveryError) }}</p>
        <div class="notification-list my-4">
            <h2 class="ws-channel-list-title">{{ $t("workspaceSavedChannels") }}</h2>
            <p v-if="!$root.notificationList.length" class="ws-subtitle">{{ $t("workspaceNoChannels") }}</p>
            <ul v-else class="list-group mb-3">
                <li
                    v-for="notification in $root.notificationList"
                    :key="notification.id"
                    class="list-group-item d-flex align-items-center justify-content-between"
                >
                    <span>
                        {{ notification.name }}
                        <small class="d-block ws-channel-note">{{ channelStatus(notification.id) }}</small>
                    </span>
                    <button type="button" class="ws-button ws-button-quiet" @click="editChannel(notification.id)">
                        {{ $t("Edit") }}
                    </button>
                </li>
            </ul>
            <button type="button" class="ws-button ws-button-quiet" @click="$refs.notificationDialog.show()">
                {{ $t("workspaceOtherChannel") }}
            </button>
        </div>
        <NotificationDialog ref="notificationDialog" />
        <DeliveryHistory />
    </section>
</template>

<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
import NotificationDialog from "./NotificationDialog.vue";
import NotificationWizard from "./NotificationWizard.vue";
import DeliveryHistory from "./DeliveryHistory.vue";
import deliveryMixin from "../mixins/notification-delivery";
export default {
    components: { WorkspaceIcon, NotificationDialog, NotificationWizard, DeliveryHistory },
    mixins: [deliveryMixin],
    props: { embedded: { type: Boolean, default: false } },
    data() {
        return { wizardType: null, wizardKey: 0, editingChannel: null, openedChannelQuery: null };
    },
    computed: {
        initialMonitor() {
            const id = Number(this.$route.query.monitor);
            return Number.isSafeInteger(id) && id > 0 ? id : null;
        },
    },
    watch: {
        "deliveryData.channels"() {
            this.openFromQuery();
        },
        "$route.query.channel"() {
            this.openedChannelQuery = null;
            this.openFromQuery();
        },
    },
    methods: {
        /** @returns {void} Open only a channel present in this owner's safe settings */
        openFromQuery() {
            const value = this.$route.query.channel;
            if (typeof value !== "string" || this.openedChannelQuery === value) {
                return;
            }
            const channel = this.deliveryData.channels.find((item) => item.id === Number(value) && item.managed);
            if (channel) {
                this.openedChannelQuery = value;
                this.openWizard(channel.type, channel);
            }
        },
        /**
         * @param {string} type Channel type
         * @param {object|null} channel Existing settings
         * @returns {void}
         */
        openWizard(type, channel = null) {
            this.editingChannel = channel;
            this.wizardKey++;
            this.wizardType = type;
        },
        /**
         * @param {number} id Channel ID
         * @returns {void}
         */
        editChannel(id) {
            const channel = this.deliveryData.channels.find((item) => item.id === id);
            if (channel?.managed) {
                this.openWizard(channel.type, channel);
            } else {
                this.$refs.notificationDialog.show(id);
            }
        },
        /**
         * @param {number} id Channel ID
         * @returns {string} Truthful saved/verified state
         */
        channelStatus(id) {
            const channel = this.deliveryData.channels.find((item) => item.id === id);
            const test =
                channel &&
                this.deliveryData.deliveries.find(
                    (job) => job.notification_id === id && job.kind === "test" && job.revision === channel.revision
                );
            return this.$t(test?.confirmed_at ? "stage2DeliveryConfirmed" : "stage2SavedNeedsTest");
        },
    },
};
</script>
