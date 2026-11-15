<template>
    <section v-if="state" class="pm-witness" data-testid="independent-witness">
        <span class="pm-ai-emblem"><WorkspaceIcon name="shield" /></span>
        <div>
            <h2>{{ $t("premiumWitnessTitle") }}</h2>
            <p>
                {{ $t(`premiumWitness_${state.state}`) }}
                <span v-if="state.label">· {{ state.label }}</span>
            </p>
            <p v-if="state.lastSeen" class="ws-channel-note">
                {{ $t("premiumWitnessLastSeen") }}: {{ time(state.lastSeen) }}
            </p>
            <p class="ws-channel-note">
                {{ $t(state.channels.length ? "premiumWitnessChannels" : "premiumWitnessNoChannels") }}
            </p>
            <p class="ws-channel-note">{{ $t("premiumWitnessHonesty") }}</p>
        </div>
    </section>
</template>
<script>
import WorkspaceIcon from "./WorkspaceIcon.vue";
import { projectRequest } from "../project-workflow";
export default {
    components: { WorkspaceIcon },
    data() {
        return { state: null, generation: 0, loading: false, clock: null };
    },
    watch: {
        "$root.socket.connected"() {
            this.clear();
            this.load();
        },
        "$root.username"() {
            this.clear();
            this.load();
        },
        "$root.loggedIn"() {
            this.clear();
            this.load();
        },
    },
    mounted() {
        this.load();
        this.clock = setInterval(() => this.load(), 15000);
    },
    beforeUnmount() {
        this.clear();
        clearInterval(this.clock);
    },
    methods: {
        /** @returns {void} Discard private deployment information on identity changes. */
        clear() {
            this.generation++;
            this.state = null;
            this.loading = false;
        },
        /** @returns {Promise<void>} Read only; never claims notification receipt. */
        async load() {
            if (
                !this.$root.loggedIn ||
                !this.$root.socket.connected ||
                this.loading ||
                !this.$root.projectAccess.installationAdmin
            )
                return;
            const generation = this.generation;
            this.loading = true;
            try {
                const result = await projectRequest(this.$root, "projectWitnessStatus");
                if (generation === this.generation) this.state = result;
            } catch {
                if (generation === this.generation) this.state = null;
            } finally {
                if (generation === this.generation) this.loading = false;
            }
        },
        /**
         * @param {number} value Saved UTC time
         * @returns {string} Local time
         */
        time(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, { dateStyle: "short", timeStyle: "medium" }).format(
                value
            );
        },
    },
};
</script>
