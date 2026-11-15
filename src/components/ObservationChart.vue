<template>
    <section class="pm-observation-chart" data-testid="observation-chart">
        <div class="pm-chart-heading">
            <h3>{{ $t("stage2RecentEvidence") }}</h3>
            <span>{{ $t("stage2ResponseTime") }}</span>
        </div>
        <svg
            v-if="chart.points.length"
            viewBox="0 0 640 232"
            role="img"
            :aria-label="$t('premiumChartDescription', { count: chart.measurements })"
        >
            <g class="pm-chart-grid">
                <line
                    v-for="line in 4"
                    :key="line"
                    x1="48"
                    x2="608"
                    :y1="26 + (line - 1) * 54"
                    :y2="26 + (line - 1) * 54"
                />
            </g>
            <g class="pm-chart-gaps">
                <rect
                    v-for="(gap, index) in chart.gaps"
                    :key="index"
                    :x="gap.x"
                    y="26"
                    :width="gap.width"
                    height="162"
                />
            </g>
            <g class="pm-chart-labels">
                <text x="37" y="30" text-anchor="end">{{ chart.ceiling }}</text>
                <text x="37" y="192" text-anchor="end">0</text>
                <text x="48" y="224">{{ time(chart.start) }}</text>
                <text x="608" y="224" text-anchor="end">{{ time(chart.end) }}</text>
            </g>
            <path
                v-for="(segment, index) in chart.segments"
                :key="index"
                class="pm-chart-line"
                :class="`pm-chart-tone-${segment.status}`"
                :d="segment.path"
                fill="none"
            />
            <template v-for="point in chart.points" :key="point.key">
                <circle
                    v-if="point.y !== null"
                    class="pm-chart-point"
                    :class="`pm-chart-tone-${point.status}`"
                    :cx="point.x"
                    :cy="point.y"
                    r="3.5"
                />
                <circle v-else-if="point.status === 0" class="pm-chart-failure" :cx="point.x" cy="202" r="3.5" />
            </template>
        </svg>
        <p v-else class="pm-chart-empty">{{ $t("workspaceWaiting") }}</p>
        <p class="ws-channel-note">{{ $t("premiumChartHonesty") }}</p>
    </section>
</template>

<script>
import { observationChart } from "../observation-chart.ts";
export default {
    props: {
        observations: { type: Array, required: true },
        interval: { type: Number, default: 60 },
        now: { type: Number, default: () => Date.now() },
    },
    computed: {
        chart() {
            return observationChart(this.observations, this.now, this.interval);
        },
    },
    methods: {
        /**
         * @param {number} value UTC epoch
         * @returns {string} A saved timestamp, not a synthetic observation
         */
        time(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, { hour: "2-digit", minute: "2-digit" }).format(value);
        },
    },
};
</script>
