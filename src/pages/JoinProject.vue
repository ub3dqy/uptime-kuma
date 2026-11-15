<template>
    <div class="workspace-shell ws-project-join" :class="{ dark: $root.theme === 'dark' }">
        <header class="workspace-header">
            <router-link to="/projects" class="workspace-brand">
                <img src="/icon.svg" width="35" height="35" alt="" />
                <span>Uptime Kuma</span>
            </router-link>
        </header>
        <main class="ws-project-join-content">
            <h1>{{ $t("projectJoinTitle") }}</h1>
            <p v-if="error" class="ws-form-error" role="alert">{{ $t(error) }}</p>
            <section v-if="invitation" class="ws-alert-wizard">
                <h2>{{ invitation.name }}</h2>
                <p>{{ $t("projectJoinAs", { role: $t(`projectRole_${invitation.role}`) }) }}</p>
                <p class="ws-channel-note">{{ $t("projectJoinHelp") }}</p>
                <form v-if="!showLogin" @submit.prevent="join">
                    <template v-if="!$root.loggedIn">
                        <label>
                            {{ $t("Username") }}
                            <input
                                v-model="username"
                                class="form-control"
                                maxlength="80"
                                required
                                autocomplete="username"
                            />
                        </label>
                        <label>
                            {{ $t("Password") }}
                            <input
                                v-model="password"
                                :aria-label="$t('Password')"
                                class="form-control"
                                type="password"
                                minlength="12"
                                maxlength="72"
                                required
                                autocomplete="new-password"
                            />
                            <small>{{ $t("projectPasswordHelp") }}</small>
                        </label>
                    </template>
                    <p v-else>{{ $t("projectJoinCurrent", { name: $root.username }) }}</p>
                    <button class="ws-button ws-button-primary" :disabled="busy" type="submit">
                        {{ $t("projectJoinAction") }}
                    </button>
                    <button
                        v-if="!$root.loggedIn"
                        class="ws-button ws-button-quiet ms-2"
                        type="button"
                        @click="showLogin = true"
                    >
                        {{ $t("projectAlreadyAccount") }}
                    </button>
                </form>
                <Login v-else />
            </section>
            <p v-else-if="!error" class="ws-channel-note" role="status">{{ $t("projectLoading") }}</p>
        </main>
    </div>
</template>
<script>
import Login from "../components/Login.vue";
import { projectRequest } from "../project-workflow";
export default {
    components: { Login },
    data() {
        return {
            token: location.hash.slice(1),
            invitation: null,
            username: "",
            password: "",
            busy: false,
            error: "",
            showLogin: false,
            generation: 0,
        };
    },
    watch: {
        "$root.socket.connected"(connected) {
            if (connected) {
                this.load();
            }
        },
        "$root.loggedIn"(loggedIn) {
            if (loggedIn) {
                this.showLogin = false;
            }
        },
    },
    mounted() {
        this.$root.initSocketIO(true);
        this.load();
    },
    beforeUnmount() {
        this.generation++;
        this.password = "";
        this.token = "";
    },
    methods: {
        /** @returns {Promise<void>} Only invitation name, role and expiry are public */
        async load() {
            if (!this.$root.socket.connected) {
                return;
            }
            const generation = this.generation;
            try {
                const result = await projectRequest(this.$root, "projectInviteInfo", { token: this.token }, true);
                if (generation === this.generation) {
                    this.invitation = result;
                }
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
            }
        },
        /** @returns {Promise<void>} Redeem exactly once; a new participant chooses their own password */
        async join() {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                const result = await projectRequest(
                    this.$root,
                    "projectAcceptInvite",
                    { token: this.token, username: this.username, password: this.password },
                    true
                );
                if (generation !== this.generation) {
                    return;
                }
                if (!this.$root.loggedIn) {
                    await new Promise((resolve, reject) =>
                        this.$root.login(this.username, this.password, "", (answer) =>
                            answer.ok ? resolve() : reject(new Error("projectOperationFailed"))
                        )
                    );
                }
                this.password = "";
                this.$router.replace(`/projects/${result.projectID}`);
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
            } finally {
                if (generation === this.generation) {
                    this.busy = false;
                }
            }
        },
    },
};
</script>
