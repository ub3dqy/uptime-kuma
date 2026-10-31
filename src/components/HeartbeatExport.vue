<template>
    <section class="shadow-box big-padding" aria-labelledby="export-history-title">
        <h2 id="export-history-title" class="h5">{{ $t("exportHistoryTitle") }}</h2>
        <p class="text-secondary small">{{ $t("exportHistoryHelp") }}</p>
        <form class="row g-3 align-items-end" @submit.prevent="downloadHistory">
            <div class="col-12 col-md-5">
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
            <div class="col-12 col-md-5">
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
            <div class="col-12 col-md-2">
                <button class="btn btn-normal w-100" type="submit" :disabled="loading || !$root.socket.connected">
                    {{ $t(loading ? "exportHistoryLoading" : "exportHistoryDownload") }}
                </button>
            </div>
        </form>
        <p v-if="error" class="text-danger mt-3 mb-0" role="alert">{{ error }}</p>
        <p v-if="notice" class="mt-3 mb-0" role="status">{{ notice }}</p>
    </section>
</template>

<script>
export default {
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
        };
    },
    methods: {
        /**
         * Download a complete bounded export, or show the reason it was refused.
         * @returns {Promise<void>}
         */
        async downloadHistory() {
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
                return;
            }
            this.loading = true;
            try {
                const result = await new Promise((resolve, reject) => {
                    this.$root
                        .getSocket()
                        .timeout(30000)
                        .emit(
                            "exportMonitorHistory",
                            {
                                monitorID: this.monitorId,
                                start: start.toISOString(),
                                end: end.toISOString(),
                            },
                            (error, response) => {
                                if (error) {
                                    reject(new Error("exportHistoryTimeout"));
                                } else {
                                    resolve(response);
                                }
                            }
                        );
                });
                if (!result.ok) {
                    this.error = this.$t(result.msg);
                    return;
                }
                if (result.rowCount === 0) {
                    this.notice = this.$t("exportHistoryEmpty");
                    return;
                }
                const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
                const link = document.createElement("a");
                link.href = url;
                link.download = result.filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) {
                this.error = this.$t(error.message === "exportHistoryTimeout" ? error.message : "exportHistoryFailed");
            } finally {
                this.loading = false;
            }
        },
    },
};
</script>
