<template>
    <div>
        <StatusPage v-if="statusPageSlug" :override-slug="statusPageSlug" />
        <main v-else-if="error" class="workspace-shell ws-access" :class="{ dark: $root.isDark }">
            <section class="ws-access-panel">
                <h1>Uptime Kuma</h1>
                <p role="alert">{{ $t("setupConnectionFailed") }}</p>
                <button type="button" class="ws-button ws-button-primary" @click="retry">
                    {{ $t("setupTryAgain") }}
                </button>
            </section>
        </main>
    </div>
</template>

<script>
import axios from "axios";
import StatusPage from "./StatusPage.vue";

export default {
    components: {
        StatusPage,
    },
    data() {
        return {
            statusPageSlug: null,
            error: false,
        };
    },
    async mounted() {
        // There are only 3 cases that could come in here.
        // 1. Matched status Page domain name
        // 2. Vue Frontend Dev
        // 3. Vue Frontend Dev (not setup database yet)
        let res;
        try {
            res = (await axios.get("/api/entry-page")).data;

            if (res.type === "statusPageMatchedDomain") {
                this.statusPageSlug = res.statusPageSlug;
                this.$root.forceStatusPageTheme = true;
            } else if (res.type === "entryPage") {
                // Dev only. For production, the logic is in the server side
                const entryPage = res.entryPage;
                if (entryPage?.startsWith("statusPage-")) {
                    this.$router.push("/status/" + entryPage.replace("statusPage-", ""));
                } else {
                    // should the old setting style still exist here?
                    this.$router.push("/dashboard");
                }
            } else if (res.type === "setup-database") {
                this.$router.push("/setup-database");
            } else {
                this.$router.push("/dashboard");
            }
        } catch {
            this.error = true;
        }
    },
    methods: {
        /** @returns {void} Retry loading the local panel. */
        retry() {
            window.location.reload();
        },
    },
};
</script>
