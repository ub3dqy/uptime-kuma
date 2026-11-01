<template>
    <div class="client-report-page">
        <div class="report-tools no-print d-flex flex-wrap gap-2 mb-4">
            <router-link to="/clients" class="btn btn-normal">{{ $t("clientGroupsTitle") }}</router-link>
            <button class="btn btn-normal" :disabled="loading || !ready" @click="loadReport">
                {{ $t("Refresh") }}
            </button>
            <button class="btn btn-primary" :disabled="!report || loading" @click="printReport">
                {{ $t("clientReportPrint") }}
            </button>
        </div>
        <div v-if="!$root.loggedIn" class="no-print"><Login v-if="$root.allowLoginDialog" /></div>
        <p v-if="loading" class="no-print" role="status">{{ $t("exportHistoryLoading") }}</p>
        <p v-if="error" class="text-danger no-print" role="alert">{{ error }}</p>
        <article v-if="report" data-testid="client-report">
            <h1>{{ $t("clientReportTitle") }}: {{ report.client.name }}</h1>
            <p class="report-range">{{ report.start }} — {{ report.end }}</p>
            <p class="small">
                {{ $t("clientReportGenerated", { time: report.generatedAt, revision: report.client.revision }) }}
            </p>
            <p class="small">{{ $t("clientReportMembership") }}</p>
            <p v-if="report.monitors.length === 0" role="status">{{ $t("clientReportEmpty") }}</p>
            <p>{{ $t("clientReportTotalsHelp", { count: report.monitors.length }) }}</p>
            <PeriodSummary :summary="totals" :show-response="false" total-label="clientReportMonitorTime" />
            <h2 class="h5 mt-4">{{ $t("clientReportPerMonitor") }}</h2>
            <div class="table-responsive report-table">
                <table class="table table-sm">
                    <caption class="visually-hidden">{{ $t("clientReportPerMonitor") }}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{{ $t("Name") }}</th>
                            <th scope="col">{{ $t("clientReportAvailability") }}</th>
                            <th scope="col">{{ $t("clientReportCoverage") }}</th>
                            <th scope="col">{{ $t("periodSummaryState_down") }}</th>
                            <th scope="col">{{ $t("periodSummaryNoData") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="monitor in report.monitors" :key="monitor.id" data-testid="client-report-monitor">
                            <th scope="row">
                                {{ monitor.name }}
                                <div class="fw-normal small">
                                    {{
                                        $t("clientReportMonitorCounts", {
                                            total: monitor.summary.counts.total,
                                            down: monitor.summary.counts.down,
                                        })
                                    }}
                                </div>
                            </th>
                            <td>{{ percent(monitor.summary.availability) }}</td>
                            <td>{{ percent(monitor.summary.coverage) }}</td>
                            <td>{{ duration(monitor.summary.time.down) }}</td>
                            <td>{{ duration(monitor.summary.time.unknown) }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <h2 class="h5 mt-4">{{ $t("periodSummaryResponse") }}</h2>
            <div class="table-responsive report-table">
                <table class="table table-sm">
                    <caption class="visually-hidden">{{ $t("periodSummaryResponse") }}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{{ $t("Name") }}</th>
                            <th scope="col">{{ $t("clientReportSamples") }}</th>
                            <th v-for="metric in metrics" :key="metric" scope="col">
                                {{ $t("periodSummaryResponse_" + metric) }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="monitor in report.monitors" :key="monitor.id">
                            <th scope="row">{{ monitor.name }}</th>
                            <td>{{ monitor.summary.response.samples }}</td>
                            <td v-for="metric in metrics" :key="metric">
                                {{ milliseconds(monitor.summary.response[metric]) }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="small">{{ $t("clientReportResponseHelp") }}</p>
        </article>
    </div>
</template>

<script>
import Login from "../components/Login.vue";
import PeriodSummary from "../components/PeriodSummary.vue";
import periodSummary from "../mixins/period-summary";

export default {
    components: { Login, PeriodSummary },
    mixins: [periodSummary],
    data() {
        return {
            report: null,
            loading: false,
            error: "",
            epoch: 0,
            metrics: ["mean", "min", "max", "p95"],
            originalTitle: document.title,
        };
    },
    computed: {
        ready() {
            return this.$root.loggedIn && this.$root.socket.connected;
        },
        totals() {
            return { ...this.report.totals, start: this.report.start, end: this.report.end };
        },
    },
    watch: {
        "$root.loggedIn"(value) {
            if (!value) {
                this.epoch++;
                this.report = null;
                this.loading = false;
                this.error = "";
                document.title = this.originalTitle;
            }
        },
        ready: {
            immediate: true,
            handler(value) {
                if (value && !this.report && !this.loading) {
                    this.loadReport();
                }
                if (!this.$root.loggedIn) {
                    this.epoch++;
                    this.report = null;
                    this.loading = false;
                    this.error = "";
                }
            },
        },
        "$route.fullPath"() {
            this.epoch++;
            this.report = null;
            if (this.ready) {
                this.loadReport();
            }
        },
    },
    beforeUnmount() {
        this.epoch++;
        document.title = this.originalTitle;
    },
    methods: {
        /** @returns {Promise<void>} Owner-authenticated report snapshot */
        async loadReport() {
            const epoch = ++this.epoch;
            this.loading = true;
            this.error = "";
            this.report = null;
            try {
                const response = await this.$root
                    .getSocket()
                    .timeout(30000)
                    .emitWithAck("getClientReport", {
                        id: Number(this.$route.params.id),
                        revision: Number(this.$route.query.revision),
                        start: this.$route.query.start,
                        end: this.$route.query.end,
                    });
                if (epoch !== this.epoch || !this.$root.loggedIn) {
                    return;
                }
                if (!response.ok) {
                    this.error = this.$t(response.msg);
                    return;
                }
                this.report = response.report;
                document.title = this.$t("clientReportTitle") + " - " + this.report.client.name;
            } catch {
                if (epoch === this.epoch) {
                    this.error = this.$t("clientGroupFailed");
                }
            } finally {
                if (epoch === this.epoch) {
                    this.loading = false;
                }
            }
        },
        /** @returns {void} Owner-controlled browser print or PDF dialog */
        printReport() {
            if (this.report && !this.loading) {
                window.print();
            }
        },
    },
};
</script>

<!-- Print rules must reach the document, toast container and nested summary tables. -->
<style lang="scss">
.client-report-page {
    max-width: 1100px;
    padding: 1.5rem;
    margin: auto;
    overflow-wrap: anywhere;

    .report-table th:first-child {
        width: 30%;
    }

    .report-range {
        overflow-wrap: anywhere;
    }
}

@media print {
    @page {
        size: a4;
        margin: 14mm;
    }

    .client-report-page .no-print,
    body:has(.client-report-page) [data-sonner-toaster] {
        display: none !important;
    }

    body:has(.client-report-page) {
        background: white !important;
        color: black !important;
    }

    .client-report-page {
        max-width: none;
        padding: 0;
        color: black;
        font-size: 10pt;

        .text-secondary,
        .table {
            color: black !important;
        }

        .table-responsive {
            overflow: visible;
        }

        table {
            table-layout: fixed;
            width: 100%;
        }

        th,
        td {
            overflow-wrap: anywhere;
        }

        thead {
            display: table-header-group;
        }

        tr,
        h1,
        h2,
        h3,
        h4 {
            break-inside: avoid;
        }

        h1,
        h2,
        h3,
        h4 {
            break-after: avoid;
        }
    }
}
</style>
