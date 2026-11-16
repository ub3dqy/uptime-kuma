<template>
    <section
        class="pm-recovery-progress"
        :class="{ 'is-working': working, 'has-warning': warning }"
        data-testid="recovery-progress"
    >
        <div class="pm-recovery-status" role="status">
            <span v-if="working" class="pm-progress-orbit" />
            <WorkspaceIcon v-else :name="warning ? 'warning' : job.status === 'succeeded' ? 'check' : 'shield'" />
            <strong>{{ $t(`projectRecoveryStatus_${job.status}`) }}</strong>
        </div>
        <ol>
            <li
                v-for="step in steps"
                :key="step.label"
                :class="{ 'is-complete': step.complete, 'is-current': step.current }"
            >
                <span>
                    <WorkspaceIcon v-if="step.complete" name="check" />
                    <template v-else>{{ step.number }}</template>
                </span>
                {{ $t(step.label) }}
            </li>
        </ol>
        <p v-if="returning" class="ws-channel-note">{{ $t("premiumRecoveryReturning") }}</p>
        <p v-else-if="job.status === 'succeeded'" class="ws-channel-note">{{ $t("projectRecoveryVerifyTwo") }}</p>
        <p v-else class="ws-channel-note">{{ $t("premiumRecoveryHonesty") }}</p>
    </section>
</template>
<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
export default {
    components: { WorkspaceIcon },
    props: { job: { type: Object, required: true } },
    computed: {
        working() {
            return [
                "queued",
                "preparing",
                "backing_up",
                "applying",
                "verifying",
                "reverting",
                "verifying_rollback",
                "recovering",
                "rollback_queued",
                "rolling_back",
            ].includes(this.job.status);
        },
        returning() {
            return [
                "reverting",
                "rollback_queued",
                "rolling_back",
                "verifying_rollback",
                "recovering",
                "rolled_back",
                "rollback_unverified",
                "rollback_failed",
                "rollback_unhealthy",
                "uncertain",
                "conflict",
            ].includes(this.job.status);
        },
        warning() {
            return [
                "rollback_unverified",
                "rollback_failed",
                "rollback_unhealthy",
                "uncertain",
                "conflict",
                "failed",
            ].includes(this.job.status);
        },
        steps() {
            return [
                { number: 1, label: "projectRecoveryStepPlan", complete: true, current: false },
                {
                    number: 2,
                    label: "projectRecoveryStepConfirm",
                    complete: !!this.job.approvedAt,
                    current: this.job.status === "planned",
                },
                {
                    number: 3,
                    label: "premiumRecoverySnapshot",
                    complete: !!this.job.snapshotAt,
                    current: ["preparing", "backing_up"].includes(this.job.status),
                },
                {
                    number: 4,
                    label: "projectRecoveryStepApply",
                    complete: !!this.job.appliedAt,
                    current: this.job.status === "applying",
                },
                {
                    number: 5,
                    label: this.returning ? "premiumRecoveryReturnCheck" : "projectRecoveryStepVerify",
                    complete: this.returning
                        ? this.job.status === "rolled_back" && this.job.rollbackVerification?.healthy === true
                        : this.job.status === "succeeded" && this.job.verification?.healthy === true,
                    current: [
                        "verifying",
                        "reverting",
                        "verifying_rollback",
                        "recovering",
                        "rollback_queued",
                        "rolling_back",
                    ].includes(this.job.status),
                },
            ];
        },
    },
};
</script>
