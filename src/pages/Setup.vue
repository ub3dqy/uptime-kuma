<template>
    <main class="workspace-shell ws-access" :class="{ dark: $root.isDark }" data-cy="setup-form">
        <div class="ws-access-panel">
            <header class="ws-access-heading">
                <span class="workspace-brand">
                    <img width="32" height="32" src="/images/kuma-pulse.png" alt="" />
                    Uptime Kuma
                </span>
                <h1 id="account-setup-title">{{ $t("Create your admin account") }}</h1>
            </header>
            <form aria-labelledby="account-setup-title" :aria-busy="processing" @submit.prevent="submit">
                <div class="form-floating">
                    <select id="language" v-model="$root.language" class="form-select">
                        <option v-for="(lang, i) in $i18n.availableLocales" :key="`Lang${i}`" :value="lang">
                            {{ $i18n.messages[lang].languageName }}
                        </option>
                    </select>
                    <label for="language" class="form-label">{{ $t("Language") }}</label>
                </div>

                <div class="form-floating mt-3">
                    <input
                        id="setup-username"
                        v-model="username"
                        type="text"
                        name="username"
                        autocomplete="username"
                        class="form-control"
                        :placeholder="$t('Username')"
                        required
                        data-cy="username-input"
                    />
                    <label for="setup-username">{{ $t("Username") }}</label>
                </div>

                <div class="form-floating mt-3">
                    <input
                        id="setup-password"
                        v-model="password"
                        type="password"
                        name="password"
                        autocomplete="new-password"
                        class="form-control"
                        :placeholder="$t('Password')"
                        required
                        data-cy="password-input"
                    />
                    <label for="setup-password">{{ $t("Password") }}</label>
                </div>

                <div class="form-floating mt-3">
                    <input
                        id="repeat"
                        v-model="repeatPassword"
                        type="password"
                        name="repeat-password"
                        autocomplete="new-password"
                        class="form-control"
                        :placeholder="$t('Repeat Password')"
                        required
                        data-cy="password-repeat-input"
                    />
                    <label for="repeat">{{ $t("Repeat Password") }}</label>
                </div>

                <button
                    class="w-100 ws-button ws-button-primary justify-content-center mt-3"
                    type="submit"
                    :disabled="processing"
                    data-cy="submit-setup-form"
                >
                    {{ $t("Create") }}
                </button>
            </form>
        </div>
    </main>
</template>

<script>
export default {
    data() {
        return {
            processing: false,
            username: "",
            password: "",
            repeatPassword: "",
        };
    },
    watch: {},
    mounted() {
        // TODO: Check if it is a database setup

        this.$root.getSocket().emit("needSetup", (needSetup) => {
            if (!needSetup) {
                this.$router.push("/");
            }
        });
    },
    methods: {
        /**
         * Submit form data for processing
         * @returns {void}
         */
        submit() {
            this.processing = true;

            if (this.password !== this.repeatPassword) {
                this.$root.toastError("PasswordsDoNotMatch");
                this.processing = false;
                return;
            }

            this.$root.getSocket().emit("setup", this.username, this.password, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.processing = true;

                    this.$root.login(this.username, this.password, "", () => {
                        this.processing = false;
                        this.$router.push("/");
                    });
                }
            });
        },
    },
};
</script>
