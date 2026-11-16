<template>
    <section class="shadow-box big-padding my-3" data-testid="monitor-verification">
        <p v-if="error" role="status" class="ws-form-error">{{ $t("verificationUnavailable") }}</p>
        <template v-if="comparison">
            <h2 class="h5">{{ $t("witnessSiteTitle") }}</h2>
            <dl class="ws-wizard-fields mb-0">
                <div v-for="point in points" :key="point.key">
                    <dt>{{ point.label }}</dt>
                    <dd>
                        {{ stateLabel(point.state) }}
                        <span v-if="point.httpStatus">В· HTTP {{ point.httpStatus }}</span>
                        <span v-if="point.responseMS !== null && point.responseMS !== undefined">
                            В· {{ $t("milliseconds", point.responseMS) }}
                        </span>
                        <small v-if="point.checkedAt" class="d-block ws-channel-note">
                            {{ when(point.checkedAt) }}
                        </small>
                    </dd>
                </div>
            </dl>
        </template>
        <template v-if="journey">
            <h2 class="h5">{{ $t("browserJourneyTitle") }}</h2>
            <p class="mb-1">
                {{
                    journey.checkedAt === null
                        ? $t("verificationMissing")
                        : journey.failedStep === null
                          ? $t("browserJourneyPassed", { count: journey.steps })
                          : journey.failedStep === 0
                            ? $t("browserJourneyLoadFailed")
                            : $t("browserJourneyFailed", { step: journey.failedStep, action: journey.action })
                }}
            </p>
            <small v-if="journey.checkedAt" class="d-block ws-channel-note">{{ when(journey.checkedAt) }}</small>
            <button
                v-if="journey.hasScreenshot && !journey.screenshot"
                type="button"
                class="ws-button ws-button-quiet mt-2"
                :disabled="loading"
                @click="refresh(true)"
            >
                {{ $t("browserJourneyScreenshot") }}
            </button>
            <img
                v-if="journey.screenshot"
                :src="'data:image/jpeg;base64,' + journey.screenshot"
                :alt="$t('browserJourneyScreenshot')"
                class="img-fluid rounded mt-3"
            />
        </template>
        <p v-if="!comparison && !journey && !error" class="ws-channel-note mb-0" role="status">
            {{ $t("verificationMissing") }}
        </p>
    </section>
</template>

<script>
import { projectRequest } from "../project-workflow";
import { workflowRequest } from "../notification-workflow";

export default {
    props: { monitorId: { type: Number, required: true }, projectId: { type: Number, default: null } },
    data() {
        return { comparison: null, journey: null, error: false, loading: false, timer: null, disposed: false };
    },
    computed: {
        points() {
            return [
                { key: "primary", label: this.$t("witnessSitePrimary"), ...this.comparison.primary },
                {
                    key: "secondary",
                    ...this.comparison.secondary,
                    label: this.comparison.secondary.label || this.$t("witnessSiteSecondary"),
                },
            ];
        },
    },
    mounted() {
        this.refresh();
        this.timer = setInterval(() => this.refresh(), 15000);
    },
    beforeUnmount() {
        this.disposed = true;
        clearInterval(this.timer);
    },
    methods: {
        /**
         * @param {boolean} includeImage Explicit request to open a protected snapshot
         * @returns {Promise<void>} Fresh verification information
         */
        async refresh(includeImage = false) {
            if (this.loading || !this.$root.loggedIn) {
                return;
            }
            this.loading = true;
            try {
                const request = { id: this.monitorId, includeImage };
                const result = this.projectId
                    ? await projectRequest(this.$root, "projectMonitorVerification", {
                          ...request,
                          projectID: this.projectId,
                      })
                    : await workflowRequest(this.$root, "getMonitorVerification", request);
                if (!this.disposed) {
                    if (
                        result.journey?.checkedAt === this.journey?.checkedAt &&
                        !includeImage &&
                        this.journey?.screenshot
                    ) {
                        result.journey.screenshot = this.journey.screenshot;
                    }
                    this.journey = result.journey;
                    this.comparison = result.comparison;
                    this.error = false;
                }
            } catch {
                this.journey = null;
                this.comparison = null;
                this.error = true;
            } finally {
                this.loading = false;
            }
        },
        /**
         * @param {string} state Stored comparison state
         * @returns {string} Localized plain text
         */
        stateLabel(state) {
            return this.$t(
                {
                    up: "workspaceStateUp",
                    down: "workspaceStateDown",
                    pending: "workspaceStatePending",
                    paused: "workspaceStatePaused",
                    maintenance: "workspaceStateMaintenance",
                    stale: "witnessSiteStale",
                }[state] || "verificationMissing"
            );
        },
        /**
         * @param {number} value UTC milliseconds
         * @returns {string} Local clock label
         */
        when(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: "short", timeStyle: "medium" }).format(
                value
            );
        },
    },
};
</script>
