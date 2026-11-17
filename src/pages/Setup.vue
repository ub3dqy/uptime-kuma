<template>
    <main class="workspace-shell ws-access" :class="{ dark: $root.isDark }" data-cy="setup-form">
        <div class="ws-access-panel">
            <header class="ws-access-heading">
                <span class="workspace-brand">
                    <img width="32" height="32" src="/images/kuma-pulse.png" alt="" />
                    Uptime Kuma
                </span>
                <h1 id="account-setup-title">{{ $t("setupOwnerTitle") }}</h1>
                <p class="ws-subtitle">{{ $t("setupOwnerIntro") }}</p>
            </header>
            <form aria-labelledby="account-setup-title" :aria-busy="processing" @submit.prevent="submit">
                <div class="form-floating mb-3">
                    <select id="setup-language" v-model="$root.language" class="form-select">
                        <option v-for="lang in $i18n.availableLocales" :key="lang" :value="lang">
                            {{ $i18n.messages[lang].languageName }}
                        </option>
                    </select>
                    <label for="setup-language">{{ $t("Language") }}</label>
                </div>
                <p v-if="fromLauncher" class="ws-channel-note">{{ $t("setupCodeReady") }}</p>
                <div v-else class="mb-3">
                    <label for="setup-code" class="form-label">{{ $t("setupCode") }}</label>
                    <input
                        id="setup-code"
                        ref="code"
                        v-model.trim="code"
                        name="setup-code"
                        type="password"
                        class="form-control"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                        maxlength="32"
                        required
                        aria-describedby="setup-code-help"
                    />
                    <small id="setup-code-help" class="ws-channel-note">{{ $t("setupCodeHelp") }}</small>
                </div>
                <div class="form-floating mb-3">
                    <input
                        id="setup-username"
                        ref="username"
                        v-model.trim="username"
                        type="text"
                        name="username"
                        autocomplete="username"
                        spellcheck="false"
                        maxlength="64"
                        class="form-control"
                        :placeholder="$t('Username')"
                        required
                        data-cy="username-input"
                    />
                    <label for="setup-username">{{ $t("Username") }}</label>
                </div>
                <div class="form-floating">
                    <input
                        id="setup-password"
                        ref="password"
                        v-model="password"
                        type="password"
                        name="password"
                        autocomplete="new-password"
                        class="form-control"
                        :placeholder="$t('Password')"
                        minlength="15"
                        maxlength="72"
                        required
                        data-cy="password-input"
                        aria-describedby="setup-password-help"
                    />
                    <label for="setup-password">{{ $t("Password") }}</label>
                </div>
                <p id="setup-password-help" class="ws-channel-note mb-3">{{ $t("setupPasswordHelp") }}</p>
                <div class="form-floating">
                    <input
                        id="repeat"
                        ref="repeat"
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
                <p v-if="error" class="ws-form-error mt-3 mb-0" role="alert">{{ $t(error) }}</p>
                <button
                    type="submit"
                    class="w-100 ws-button ws-button-primary justify-content-center mt-4"
                    :disabled="processing"
                >
                    {{ $t(processing ? "setupSaving" : "setupCreateOwner") }}
                </button>
            </form>
        </div>
    </main>
</template>

<script>
import { setupCodeFromLink } from "../setup-link";

export default {
    data() {
        return {
            code: "",
            fromLauncher: false,
            username: "",
            password: "",
            repeatPassword: "",
            processing: false,
            error: "",
        };
    },
    watch: {
        "$route.hash": {
            immediate: true,
            handler(hash) {
                const code = setupCodeFromLink(hash);
                if (this.$route.path === "/setup" && code) {
                    this.code = code;
                    this.fromLauncher = true;
                    this.$router.replace({ hash: "" });
                }
            },
        },
    },
    mounted() {
        this.$root.getSocket().emit("needSetup", (needsSetup) => {
            if (!needsSetup) {
                this.$router.replace("/dashboard");
            }
        });
    },
    beforeUnmount() {
        this.code = "";
        this.password = "";
        this.repeatPassword = "";
    },
    methods: {
        /** @returns {void} Create the first account once using the installation code. */
        submit() {
            if (this.processing) {
                return;
            }
            if (this.password !== this.repeatPassword) {
                this.error = "PasswordsDoNotMatch";
                this.$refs.repeat.focus();
                return;
            }
            if ([...this.password].length < 15 || new TextEncoder().encode(this.password).length > 72) {
                this.error = "setupPasswordInvalid";
                this.$refs.password.focus();
                return;
            }
            this.error = "";
            this.processing = true;
            this.$root
                .getSocket()
                .timeout(15000)
                .emit(
                    "setup",
                    { username: this.username, password: this.password, code: this.code },
                    (failure, result) => {
                        if (failure || !result?.ok) {
                            this.processing = false;
                            this.error = result?.msg || "setupSaveFailed";
                            if (this.error === "setupCodeInvalid") {
                                this.code = "";
                                this.fromLauncher = false;
                                this.$nextTick(() => this.$refs.code?.focus());
                            }
                            return;
                        }
                        this.code = "";
                        this.$root.login(this.username, this.password, "", (login) => {
                            this.processing = false;
                            this.password = "";
                            this.repeatPassword = "";
                            this.$router.replace(login.ok ? "/start" : "/dashboard");
                        });
                    }
                );
        },
    },
};
</script>
