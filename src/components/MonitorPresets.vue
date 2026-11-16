<template>
    <section class="ws-monitor-presets" aria-labelledby="monitor-preset-title">
        <h2 id="monitor-preset-title">{{ $t("stage2WhatToCheck") }}</h2>
        <p class="ws-channel-note">{{ $t("stage2PresetHelp") }}</p>
        <div class="ws-preset-grid">
            <button
                v-for="preset in presets"
                :key="preset.key"
                type="button"
                :aria-pressed="selected === preset.key"
                :class="{ selected: selected === preset.key }"
                @click="choose(preset)"
            >
                <WorkspaceIcon :name="preset.icon" />
                <strong>{{ $t(preset.title) }}</strong>
                <span>{{ $t(preset.help) }}</span>
            </button>
        </div>
        <p v-if="selected === 'backup'" class="ws-channel-note">{{ $t("stage2BackupHonesty") }}</p>
    </section>
</template>
<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
export default {
    components: { WorkspaceIcon },
    emits: ["select"],
    data() {
        return {
            selected: "",
            presets: [
                {
                    key: "site",
                    title: "stage2PresetSite",
                    help: "stage2PresetSiteHelp",
                    icon: "overview",
                    type: "http",
                },
                {
                    key: "speed",
                    title: "stage2PresetSpeed",
                    help: "stage2PresetSpeedHelp",
                    icon: "activity",
                    type: "http",
                },
                {
                    key: "certificate",
                    title: "stage2PresetCertificate",
                    help: "stage2PresetCertificateHelp",
                    icon: "check",
                    type: "http",
                },
                { key: "dns", title: "stage2PresetDNS", help: "stage2PresetDNSHelp", icon: "reports", type: "dns" },
                {
                    key: "port",
                    title: "stage2PresetPort",
                    help: "stage2PresetPortHelp",
                    icon: "monitors",
                    type: "port",
                },
                {
                    key: "backup",
                    title: "stage2PresetBackup",
                    help: "stage2PresetBackupHelp",
                    icon: "clock",
                    type: "push",
                },
            ],
        };
    },
    methods: {
        /**
         * @param {object} preset Selected check
         * @returns {void} Apply only before explicitly saving a new monitor
         */
        choose(preset) {
            this.selected = preset.key;
            this.$emit("select", {
                type: preset.type,
                max_response_time: preset.key === "speed" ? 1000 : null,
                interval: preset.key === "backup" ? 86400 : 60,
                retryInterval: 30,
                maxretries: preset.key === "backup" ? 0 : 2,
                ignoreTls: false,
                expiryNotification: preset.key === "certificate",
                domainExpiryNotification: preset.type === "http",
                upsideDown: false,
            });
        },
    },
};
</script>
