<template>
    <section class="pm-observation-chart" data-testid="observation-chart">
        <div class="pm-chart-heading">
            <h3>{{ $t("stage2RecentEvidence") }}</h3>
            <span>{{ $t("stage2ResponseTime") }}</span>
        </div>
        <ObservationTrace :monitor-id="monitorId" :name="name" :observations="observations" :now="now" detailed />
        <p class="ws-channel-note mb-0 mt-2">{{ $t("premiumChartHonesty") }}</p>
    </section>
</template>

<script>
import ObservationTrace from "./ObservationTrace.vue";

export default {
    components: { ObservationTrace },
    props: {
        monitorId: { type: Number, required: true },
        name: { type: String, required: true },
        observations: { type: Array, required: true },
        now: { type: Number, required: true },
    },
};
</script>
