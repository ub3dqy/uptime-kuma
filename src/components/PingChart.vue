<template>
    <section class="history-chart" :aria-labelledby="headingId" :aria-busy="loading">
        <header class="history-heading">
            <div>
                <p class="ws-eyebrow">{{ $t("Monitor History") }}</p>
                <h2 :id="headingId">{{ $t("workspaceResponseHistory") }}</h2>
            </div>
            <div>
                <label class="form-label" :for="headingId + '-period'">{{ $t("workspaceHistoryPeriod") }}</label>
                <select
                    :id="headingId + '-period'"
                    v-model.number="period"
                    class="form-select"
                    data-testid="history-chart-period"
                >
                    <option v-for="hours in periods" :key="hours" :value="hours">
                        {{ hours === 168 ? $t("days", 7) : $t("hours", hours) }}
                    </option>
                </select>
            </div>
        </header>
        <p v-if="loading" class="history-note" role="status">{{ $t("exportHistoryLoading") }}</p>
        <div v-else-if="error" class="history-note">
            <p role="alert">{{ $t("workspaceHistoryLoadFailed") }}</p>
            <button type="button" class="ws-button ws-button-quiet" @click="load">{{ $t("Retry") }}</button>
        </div>
        <p v-else-if="!points.length" class="history-note" role="status">{{ $t("workspaceWaiting") }}</p>
        <template v-else>
            <div class="chart-wrapper">
                <LineChart
                    :data="chartData"
                    :options="chartOptions"
                    role="img"
                    :aria-label="$t('workspaceResponseHistory')"
                />
            </div>
            <p v-if="!hasResponse" class="history-note" role="status">{{ $t("premiumTraceNoResponse") }}</p>
            <ul class="history-legend" :aria-label="$t('Status')">
                <li>
                    <i class="history-key-down" />
                    {{ $t("workspaceStateDown") }}
                </li>
                <li>
                    <i class="history-key-mixed" />
                    {{ $t("workspaceHistoryMixed") }}
                </li>
                <li>
                    <i class="history-key-maintenance" />
                    {{ $t("workspaceStateMaintenance") }}
                </li>
            </ul>
            <p class="history-note mb-0">{{ $t("workspaceHistoryBuckets") }}</p>
        </template>
    </section>
</template>

<script>
import {
    BarController,
    BarElement,
    Chart,
    Filler,
    Legend,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    TimeScale,
    Tooltip,
} from "chart.js";
import "chartjs-adapter-dayjs-4";
import { useId } from "vue";
import { Line as LineChart } from "vue-chartjs";
import { responseBuckets } from "../observation-chart.ts";

Chart.register(
    BarController,
    BarElement,
    Filler,
    Legend,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    TimeScale,
    Tooltip
);

const periods = [3, 6, 24, 168];
const statusColors = { maintenance: "#687fd280", mixed: "#cd8c217d", down: "#ce465a80" };

export default {
    components: { LineChart },
    props: {
        monitorId: { type: Number, required: true },
    },
    setup() {
        return { headingId: useId() + "-response-history" };
    },
    data() {
        const saved = Number(this.$root.storage()["chart-period"]);
        return {
            periods,
            period: periods.includes(saved) ? saved : 3,
            buckets: [],
            loading: true,
            error: false,
            request: 0,
            timer: null,
            motion: null,
            reduced: false,
        };
    },
    computed: {
        points() {
            return responseBuckets(this.buckets, this.period > 24 ? 3600 : 60);
        },
        hasResponse() {
            return this.points.some((point) => point.avg !== null);
        },
        chartData() {
            const dark = this.$root.isDark;
            const lines = [
                { key: "avg", label: "avgPing", color: dark ? "#76e0b2" : "#087b56", width: 2, fill: true },
                { key: "min", label: "minPing", color: dark ? "#7bb8e3" : "#326b9d", width: 1.3, dash: [4, 3] },
                { key: "max", label: "maxPing", color: dark ? "#b5a8f3" : "#6955a0", width: 1.3, dash: [2, 3] },
            ];
            return {
                datasets: [
                    ...lines.map(({ key, label, color, width, fill, dash }) => ({
                        label: this.$t(label),
                        data: this.points.map((point) => ({ x: point.x, y: point[key] })),
                        yAxisID: "y",
                        borderColor: color,
                        backgroundColor: fill ? (dark ? "#76e0b220" : "#087b561b") : color,
                        borderDash: dash ?? [],
                        borderWidth: width,
                        pointRadius: (context) => {
                            const index = context.dataIndex;
                            return this.points[index - 1]?.[key] == null && this.points[index + 1]?.[key] == null
                                ? 2
                                : 0;
                        },
                        fill: fill ? "origin" : false,
                    })),
                    {
                        type: "bar",
                        label: this.$t("Status"),
                        data: this.points.map((point) => ({ x: point.x, y: point.tone ? 1 : null })),
                        backgroundColor: this.points.map((point) => statusColors[point.tone] ?? "transparent"),
                        barThickness: "flex",
                        yAxisID: "state",
                        order: 2,
                    },
                ],
            };
        },
        chartOptions() {
            const dark = this.$root.isDark;
            const ink = dark ? "#e4ebf5" : "#14213b";
            const muted = dark ? "#a9b8cc" : "#5d6b81";
            const grid = dark ? "#2e3d51" : "#dfe7ef";
            const locale = this.$i18n.locale;
            let timeZone;
            try {
                timeZone = new Intl.DateTimeFormat(locale, { timeZone: this.$root.timezone }).resolvedOptions()
                    .timeZone;
            } catch {
                // A saved zone from another browser may be unavailable here.
                timeZone = undefined;
            }
            const ticks = new Intl.DateTimeFormat(locale, {
                hour: "2-digit",
                minute: "2-digit",
                timeZone,
                ...(this.period > 24 ? { month: "short", day: "numeric" } : {}),
            });
            const tooltipTime = new Intl.DateTimeFormat(locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone,
            });
            const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
            return {
                responsive: true,
                maintainAspectRatio: false,
                animation: this.reduced ? false : { duration: 240, easing: "easeOutQuad" },
                parsing: false,
                normalized: true,
                color: muted,
                interaction: { intersect: false, mode: "index" },
                scales: {
                    x: {
                        type: "time",
                        time: { minUnit: "minute" },
                        ticks: {
                            color: muted,
                            maxRotation: 0,
                            maxTicksLimit: 6,
                            callback: (value) => ticks.format(value),
                        },
                        grid: { color: grid },
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: grid },
                        ticks: { color: muted },
                        title: { display: true, text: this.$t("respTime"), color: muted },
                    },
                    state: { axis: "y", display: false, min: 0, max: 1 },
                },
                plugins: {
                    legend: {
                        align: "start",
                        onClick: null,
                        labels: { color: ink, boxWidth: 18, filter: (item) => item.datasetIndex < 3 },
                    },
                    tooltip: {
                        filter: (item) => item.dataset.type !== "bar" && item.parsed.y !== null,
                        backgroundColor: dark ? "#243449" : "#fff",
                        titleColor: ink,
                        bodyColor: ink,
                        borderColor: grid,
                        borderWidth: 1,
                        callbacks: {
                            title: (items) => (items.length ? tooltipTime.format(items[0].parsed.x) : ""),
                            label: (item) =>
                                item.dataset.label +
                                ": " +
                                this.$t("workspaceMilliseconds", { value: number.format(item.parsed.y) }),
                        },
                    },
                },
            };
        },
    },
    watch: {
        period() {
            this.load();
        },
    },
    mounted() {
        this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
        this.updateMotion();
        this.motion.addEventListener("change", this.updateMotion);
        this.load();
        this.timer = setInterval(() => this.load(false), 5 * 60 * 1000);
    },
    beforeUnmount() {
        this.request++;
        clearInterval(this.timer);
        this.motion.removeEventListener("change", this.updateMotion);
    },
    methods: {
        /** @returns {void} Honor the current motion preference even when it changes while open */
        updateMotion() {
            this.reduced = this.motion.matches;
        },
        /**
         * @param {boolean} showLoading Show progress on initial load or a period change
         * @returns {void}
         */
        load(showLoading = true) {
            if (showLoading !== false) {
                this.loading = true;
                this.error = false;
            } else if (this.loading) {
                return;
            }
            const request = ++this.request;
            this.$root
                .getSocket()
                .timeout(12000)
                .emit("getMonitorChartData", this.monitorId, this.period, (error, res) => {
                    if (request !== this.request) return;
                    this.loading = false;
                    if (!error && res?.ok && Array.isArray(res.data)) {
                        this.buckets = res.data;
                        this.error = false;
                        this.$root.storage()["chart-period"] = String(this.period);
                    } else if (showLoading !== false || !this.buckets.length) {
                        this.error = true;
                        this.buckets = [];
                    }
                });
        },
    },
};
</script>

<style lang="scss" scoped>
.history-chart {
    min-width: 0;
    text-align: start;
}

.history-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 14px;
    margin-block-end: 14px;
}

.history-heading h2 {
    margin: 0;
    font-size: clamp(18px, 3vw, 22px);
    font-weight: 700;
}

.history-heading label,
.history-note {
    color: var(--ws-muted);
}

.chart-wrapper {
    position: relative;
    width: 100%;
    height: clamp(210px, 36vw, 285px);
    overflow: hidden;
}

.chart-wrapper :deep(canvas) {
    max-width: 100%;
}

.history-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 0;
    margin-block: 10px;
    color: var(--ws-muted);
    font-size: 13px;
    list-style: none;
}

.history-legend li {
    display: inline-flex;
    gap: 6px;
    align-items: center;
}

.history-legend i {
    width: 9px;
    height: 9px;
    border: 1px solid currentcolor;
    border-radius: 2px;
    background: currentcolor;
}

.history-key-down {
    color: var(--ws-danger);
}

.history-key-mixed {
    color: var(--ws-warning);
}

.history-key-maintenance {
    color: var(--trace-maintenance);
}
</style>
