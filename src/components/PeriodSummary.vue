<template>
    <div class="mt-4" data-testid="period-summary" aria-labelledby="period-summary-title" aria-live="polite">
        <h3 id="period-summary-title" class="h5">{{ $t("periodSummaryTitle") }}</h3>
        <p class="small text-secondary period-range">{{ summary.start }} — {{ summary.end }}</p>
        <p class="small">{{ $t("periodSummaryMethod") }}</p>
        <div class="row gx-0 gy-3 mb-3">
            <div class="col-12 col-sm-6">
                <div>{{ $t("periodSummaryAvailability") }}</div>
                <strong class="fs-4" data-testid="summary-availability">{{ percent(summary.availability) }}</strong>
            </div>
            <div class="col-12 col-sm-6">
                <div>{{ $t("periodSummaryCoverage") }}</div>
                <strong class="fs-4" data-testid="summary-coverage">{{ percent(summary.coverage) }}</strong>
            </div>
        </div>
        <p class="small text-secondary">{{ $t("periodSummaryDenominator") }}</p>
        <p class="small text-secondary">{{ $t("periodSummaryRetention") }}</p>
        <p>{{ $t("periodSummaryCheckCount", { total: summary.counts.total, unknown: summary.counts.unknown }) }}</p>
        <p v-if="summary.counts.total === 0" role="status">{{ $t("periodSummaryEmpty") }}</p>
        <p v-if="summary.legacyChecks > 0" class="small" role="status">{{ $t("periodSummaryLegacy") }}</p>
        <div class="table-responsive">
            <table class="table table-sm align-middle">
                <caption class="visually-hidden">{{ $t("periodSummaryTimeTable") }}</caption>
                <thead>
                    <tr>
                        <th scope="col">{{ $t("Status") }}</th>
                        <th scope="col">{{ $t("periodSummaryTime") }}</th>
                        <th scope="col">{{ $t("periodSummaryChecks") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="state in states" :key="state" :data-testid="'summary-' + state">
                        <th scope="row">{{ $t("periodSummaryState_" + state) }}</th>
                        <td>{{ duration(summary.time[state]) }}</td>
                        <td>{{ summary.counts[state] }}</td>
                    </tr>
                    <tr data-testid="summary-unknown">
                        <th scope="row">{{ $t("periodSummaryNoData") }}</th>
                        <td>{{ duration(summary.time.unknown) }}</td>
                        <td>—</td>
                    </tr>
                    <tr>
                        <th scope="row">{{ $t("periodSummaryTotal") }}</th>
                        <td>{{ duration(summary.time.total) }}</td>
                        <td>{{ summary.counts.total }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <p class="small">{{ $t("periodSummaryGapHelp") }}</p>
        <h4 class="h6">{{ $t("periodSummaryResponse") }}</h4>
        <dl class="row gx-0 mb-0" data-testid="summary-response">
            <dt class="col-7 col-sm-8">{{ $t("periodSummarySamples") }}</dt>
            <dd class="col-5 col-sm-4">{{ summary.response.samples }}</dd>
            <template v-for="metric in metrics" :key="metric">
                <dt class="col-7 col-sm-8">{{ $t("periodSummaryResponse_" + metric) }}</dt>
                <dd class="col-5 col-sm-4">{{ milliseconds(summary.response[metric]) }}</dd>
            </template>
        </dl>
    </div>
</template>

<script>
export default {
    props: {
        summary: { type: Object, required: true },
    },
    data() {
        return {
            states: ["up", "down", "pending", "maintenance"],
            metrics: ["mean", "min", "max", "p95"],
        };
    },
    methods: {
        /**
         * @param {number|null} value Ratio
         * @returns {string} Localized percentage
         */
        percent(value) {
            if (value === null) {
                return this.$t("periodSummaryUnavailable");
            }
            const options = { style: "percent", maximumFractionDigits: 2 };
            // Rounding must not turn a small gap into complete coverage or availability.
            if (value < 1 && value >= 0.99995) {
                return "< " + this.$n(1, options);
            }
            if (value > 0 && value < 0.0001) {
                return "< " + this.$n(0.0001, options);
            }
            return this.$n(value, options);
        },
        /**
         * @param {number} value Milliseconds
         * @returns {string} Duration without rounding small gaps away
         */
        duration(value) {
            let remaining = value;
            const parts = [];
            for (const [unit, divisor] of [
                ["day", 86400000],
                ["hour", 3600000],
                ["minute", 60000],
                ["second", 1000],
            ]) {
                const amount = unit === "second" ? remaining / divisor : Math.floor(remaining / divisor);
                if (amount > 0 || (unit === "second" && parts.length === 0)) {
                    parts.push(
                        this.$n(amount, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 3 })
                    );
                }
                remaining -= Math.floor(remaining / divisor) * divisor;
            }
            return parts.join(" ");
        },
        /**
         * @param {number|null} value Milliseconds
         * @returns {string} Localized latency or no-data marker
         */
        milliseconds(value) {
            return value === null
                ? this.$t("periodSummaryUnavailable")
                : this.$t("periodSummaryMilliseconds", { value: this.$n(value, { maximumFractionDigits: 2 }) });
        },
    },
};
</script>

<style scoped>
.period-range {
    overflow-wrap: anywhere;
}
</style>
