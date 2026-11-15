<template>
    <section class="ws-project-panel" data-testid="project-account">
        <p class="ws-eyebrow">{{ $root.username }}</p>
        <h1 class="ws-page-title">{{ $t("projectMyAccount") }}</h1>
        <p>{{ $t("projectMyAccountHelp") }}</p>
        <p v-if="error" role="alert" class="ws-form-error">{{ $t(error) }}</p>
        <p v-if="saved" role="status" class="ws-test-state">{{ $t("successAuthChangePassword") }}</p>
        <form data-testid="account-password-form" @submit.prevent="save">
            <div class="ws-wizard-fields">
                <label>
                    {{ $t("Current Password") }}
                    <input
                        v-model="currentPassword"
                        type="password"
                        class="form-control"
                        autocomplete="current-password"
                        required
                    />
                </label>
                <label>
                    {{ $t("New Password") }}
                    <input
                        v-model="newPassword"
                        type="password"
                        class="form-control"
                        autocomplete="new-password"
                        minlength="12"
                        maxlength="72"
                        required
                    />
                </label>
                <label>
                    {{ $t("Repeat New Password") }}
                    <input
                        v-model="repeated"
                        type="password"
                        class="form-control"
                        autocomplete="new-password"
                        minlength="12"
                        maxlength="72"
                        required
                    />
                </label>
            </div>
            <p class="ws-channel-note">{{ $t("projectPasswordHelp") }}</p>
            <button class="ws-button ws-button-primary" type="submit" :disabled="busy">
                {{ $t("Change Password") }}
            </button>
        </form>
        <button class="ws-button ws-button-quiet mt-4" type="button" @click="$refs.twoFA.show()">
            {{ $t("2FA Settings") }}
        </button>
        <TwoFADialog ref="twoFA" />
    </section>
</template>
<script>
import TwoFADialog from "../components/TwoFADialog.vue";
import { projectRequest } from "../project-workflow";
export default {
    components: { TwoFADialog },
    data() {
        return {
            currentPassword: "",
            newPassword: "",
            repeated: "",
            busy: false,
            error: "",
            saved: false,
            generation: 0,
        };
    },
    beforeUnmount() {
        this.generation++;
        this.currentPassword = "";
        this.newPassword = "";
        this.repeated = "";
    },
    methods: {
        /** @returns {Promise<void>} Change only this human's password and retain the replacement session */
        async save() {
            this.error = "";
            this.saved = false;
            if (this.newPassword !== this.repeated) {
                this.error = "projectPasswordsMismatch";
                return;
            }
            const generation = this.generation;
            this.busy = true;
            try {
                const result = await projectRequest(this.$root, "changePassword", {
                    currentPassword: this.currentPassword,
                    newPassword: this.newPassword,
                });
                if (generation !== this.generation) {
                    return;
                }
                this.$root.storage().token = result.token;
                this.$root.socket.token = result.token;
                this.currentPassword = "";
                this.newPassword = "";
                this.repeated = "";
                this.saved = true;
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
