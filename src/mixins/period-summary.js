export default {
    methods: {
        /**
         * @param {number|null} value Ratio
         * @returns {string} Localized percentage without false complete coverage
         */
        percent(value) {
            if (value === null) {
                return this.$t("periodSummaryUnavailable");
            }
            const options = { style: "percent", maximumFractionDigits: 2 };
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
         * @returns {string} Localized duration retaining millisecond gaps
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
         * @returns {string} Localized response time
         */
        milliseconds(value) {
            return value === null
                ? this.$t("periodSummaryUnavailable")
                : this.$t("periodSummaryMilliseconds", { value: this.$n(value, { maximumFractionDigits: 2 }) });
        },
    },
};
