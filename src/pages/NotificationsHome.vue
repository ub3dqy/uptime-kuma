<template>
    <div>
        <NotificationChannels />
        <div class="workspace-alerts-intro"><IndependentWitness /></div>
        <div class="workspace-alert-settings">
            <router-link to="/settings/notifications" class="ws-button ws-button-quiet">
                <WorkspaceIcon name="settings" />
                {{ $t("workspaceAdvancedAlerts") }}
            </router-link>
        </div>
    </div>
</template>

<script>
import NotificationChannels from "../components/NotificationChannels.vue";
import WorkspaceIcon from "../components/WorkspaceIcon.vue";
import IndependentWitness from "../components/IndependentWitness.vue";
export default { components: { NotificationChannels, WorkspaceIcon, IndependentWitness } };
</script>
