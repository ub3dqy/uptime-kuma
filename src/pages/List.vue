<template>
    <Overview services-page>
        <template #actions>
            <button
                class="ws-button ws-button-quiet"
                type="button"
                :aria-expanded="managementOpen"
                aria-controls="workspace-management"
                data-testid="service-management-open"
                @click="openManagement"
            >
                <WorkspaceIcon name="monitors" />
                {{ $t("workspaceManageChecks") }}
            </button>
        </template>
        <template #management>
            <details
                id="workspace-management"
                ref="management"
                class="ws-management"
                data-testid="service-management"
                :open="managementOpen"
                @toggle="managementOpen = $event.target.open"
            >
                <summary>{{ $t("workspaceManageChecks") }}</summary>
                <p class="ws-channel-note">{{ $t("workspaceManagementHelp") }}</p>
                <MonitorList v-if="managementOpen" :scrollbar="false" />
            </details>
        </template>
    </Overview>
</template>

<script>
import MonitorList from "../components/MonitorList.vue";
import WorkspaceIcon from "../components/WorkspaceIcon.vue";
import Overview from "./Overview.vue";

export default {
    components: {
        MonitorList,
        WorkspaceIcon,
        Overview,
    },
    data() {
        return { managementOpen: false };
    },
    methods: {
        /** @returns {void} Reveal the preserved bulk, tag and ordering controls */
        openManagement() {
            this.managementOpen = true;
            this.$nextTick(() => {
                const panel = this.$refs.management;
                panel?.scrollIntoView({
                    block: "start",
                    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                });
                panel?.querySelector("summary")?.focus({ preventScroll: true });
            });
        },
    },
};
</script>
