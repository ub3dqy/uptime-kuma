<template>
    <section class="ws-delivery-history" data-testid="delivery-history">
        <h3>{{ $t("stage2DeliveryHistory") }}</h3>
        <p v-if="deliveryError" role="status">{{ $t(deliveryError) }}</p>
        <p v-else-if="!deliveryData.channels.length" class="ws-channel-note">
            {{ $t(monitorId ? "stage2NoAssignedChannels" : "workspaceNoChannels") }}
        </p>
        <p v-else-if="!deliveryData.deliveries.length" class="ws-channel-note">{{ $t("stage2NoDeliveryHistory") }}</p>
        <ul v-else class="ws-delivery-rows">
            <li v-for="job in deliveryData.deliveries.slice(0, compact ? 5 : 20)" :key="job.id">
                <div>
                    <strong>{{ channelName(job.notification_id) }}</strong>
                    <small>{{ $t(kinds[job.kind] || "stage2KindTest") }} · {{ formatTime(job.created_at) }}</small>
                </div>
                <div>
                    <span>{{ $t(label(job)) }}</span>
                    <small v-if="job.error_code">{{ $t(`stage2DeliveryError_${job.error_code}`) }}</small>
                    <small v-if="job.status === 'queued' && job.attempts">
                        {{ $t("stage2RetryAt", { time: formatTime(job.next_attempt_at) }) }}
                    </small>
                </div>
            </li>
        </ul>
        <p class="ws-channel-note">{{ $t("stage2DeliveryHonesty") }}</p>
    </section>
</template>
<script>
import deliveryMixin from "../mixins/notification-delivery";
import { deliveryLabel } from "../notification-workflow";
export default {
    mixins: [deliveryMixin],
    props: { compact: { type: Boolean, default: false } },
    data() {
        return {
            kinds: {
                test: "stage2KindTest",
                up: "stage2KindRecovery",
                down: "stage2KindFailure",
                work: "siteWorkDelivery",
                certificate: "stage2KindCertificate",
                domain: "stage2KindDomain",
            },
        };
    },
    methods: {
        label: deliveryLabel,
        /**
         * @param {number} id Channel ID
         * @returns {string} Channel name
         */
        channelName(id) {
            return this.deliveryData.channels.find((channel) => channel.id === id)?.name || this.$t("stage2Channel");
        },
        /**
         * @param {number} value UTC milliseconds
         * @returns {string} Display time
         */
        formatTime(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: "short", timeStyle: "medium" }).format(
                new Date(Number(value))
            );
        },
    },
};
</script>
