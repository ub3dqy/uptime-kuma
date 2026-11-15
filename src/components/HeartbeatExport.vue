<template>
    <section class="shadow-box big-padding" aria-labelledby="export-history-title">
        <h2 id="export-history-title" class="h5">{{ $t("exportHistoryTitle") }}</h2>
        <p class="text-secondary small">{{ $t("exportHistoryHelp") }}</p>
        <form class="row g-3 align-items-end" @submit.prevent="downloadHistory">
            <div class="col-12 col-md-4">
                <label for="export-history-start" class="form-label">{{ $t("exportHistoryStartUTC") }}</label>
                <input
                    id="export-history-start"
                    v-model="start"
                    class="form-control"
                    type="datetime-local"
                    required
                    :disabled="loading"
                />
            </div>
            <div class="col-12 col-md-4">
                <label for="export-history-end" class="form-label">{{ $t("exportHistoryEndUTC") }}</label>
                <input
                    id="export-history-end"
                    v-model="end"
                    class="form-control"
                    type="datetime-local"
                    required
                    :disabled="loading"
                />
            </div>
            <div class="col-12 col-md-4 d-flex flex-wrap gap-2">
                <button
                    class="btn btn-primary"
                    type="button"
                    :disabled="loading || !$root.socket.connected"
                    @click="loadSummary"
                >
                    {{ $t(loading ? "exportHistoryLoading" : "periodSummaryCalculate") }}
                </button>
                <button class="btn btn-normal" type="submit" :disabled="loading || !$root.socket.connected">
                    {{ $t(loading ? "exportHistoryLoading" : "exportHistoryDownload") }}
                </button>
            </div>
        </form>
        <p v-if="error" class="text-danger mt-3 mb-0" role="alert">{{ error }}</p>
        <p v-if="notice" class="mt-3 mb-0" role="status">{{ notice }}</p>
        <PeriodSummary v-if="summary" :summary="summary" />
    </section>
</template>

<script>
import PeriodSummary from "./PeriodSummary.vue";

export default {
    components: { PeriodSummary },
    props: {
        monitorId: { type: Number, required: true },
    },
    data() {
        return {
            start: new Date(Date.now() - 86400000).toISOString().slice(0, 16),
            end: new Date().toISOString().slice(0, 16),
            loading: false,
            error: "",
            notice: "",
            summary: null,
        };
    },
    watch: {
        start() {
            this.summary = null;
        },
        end() {
            this.summary = null;
        },
    },
    methods: {
        /**
         * Validate the shared period and request an owner-scoped result.
         * @param {string} event Socket event
         * @returns {Promise<object|null>} Result, or a visible error
         */
        async requestHistory(event) {
            this.error = "";
            this.notice = "";
            const start = new Date(this.start + ":00.000Z");
            const end = new Date(this.end + ":00.000Z");
            if (
                !Number.isFinite(start.getTime()) ||
                !Number.isFinite(end.getTime()) ||
                start >= end ||
                end - start > 31 * 86400000
            ) {
                this.error = this.$t("exportHistoryInvalidRange");
                return null;
            }
            this.loading = true;
            try {
                const result = await new Promise((resolve, reject) => {
                    this.$root
                        .getSocket()
                        .timeout(30000)
                        .emit(
                            event,
                            {
                                monitorID: this.monitorId,
                                start: start.toISOString(),
                                end: end.toISOString(),
                            },
                            (error, response) => {
                                if (error) {
                                    reject(
                                        new Error(
                                            event === "getMonitorPeriodSummary"
                                                ? "periodSummaryTimeout"
                                                : "exportHistoryTimeout"
                                        )
                                    );
                                } else {
                                    resolve(response);
                                }
                            }
                        );
                });
                if (!result.ok) {
                    this.error = this.$t(result.msg);
                    return null;
                }
                return result;
            } catch (error) {
                const isSummary = event === "getMonitorPeriodSummary";
                const timeout = isSummary ? "periodSummaryTimeout" : "exportHistoryTimeout";
                const failed = isSummary ? "periodSummaryFailed" : "exportHistoryFailed";
                this.error = this.$t(error.message === timeout ? timeout : failed);
                return null;
            } finally {
                this.loading = false;
            }
        },
        /**
         * Calculate a summary without replacing it with results for a different period.
         * @returns {Promise<void>}
         */
        async loadSummary() {
            this.summary = null;
            const result = await this.requestHistory("getMonitorPeriodSummary");
            if (result) {
                this.summary = result.summary;
            }
        },
        /**
         * Download a complete bounded export, or show the reason it was refused.
         * @returns {Promise<void>}
         */
        async downloadHistory() {
            const result = await this.requestHistory("exportMonitorHistory");
            if (!result) {
                return;
            }
            if (result.rowCount === 0) {
                this.notice = this.$t("exportHistoryEmpty");
                return;
            }
            try {
                const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
                try {
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = result.filename;
                    try {
                        document.body.appendChild(link);
                        link.click();
                    } finally {
                        link.remove();
                    }
                } finally {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
            } catch {
                this.error = this.$t("exportHistoryFailed");
            }
        },
    },
};
</script>
