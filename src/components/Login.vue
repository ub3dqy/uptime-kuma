<template>
    <div :class="{ 'ws-access': !embedded }">
        <div :class="{ 'ws-access-panel': !embedded }">
            <header class="ws-access-heading">
                <component :is="embedded ? 'h2' : 'h1'" :id="headingId">{{ $t("Login") }}</component>
            </header>
            <form :aria-labelledby="headingId" :aria-busy="processing" @submit.prevent="submit">
                <div v-if="!tokenRequired" class="form-floating">
                    <input
                        :id="headingId + '-username'"
                        v-model="username"
                        type="text"
                        name="username"
                        class="form-control"
                        :placeholder="$t('Username')"
                        autocomplete="username"
                        required
                    />
                    <label :for="headingId + '-username'">{{ $t("Username") }}</label>
                </div>

                <div v-if="!tokenRequired" class="form-floating mt-3">
                    <input
                        :id="headingId + '-password'"
                        v-model="password"
                        type="password"
                        name="password"
                        class="form-control"
                        :placeholder="$t('Password')"
                        autocomplete="current-password"
                        required
                    />
                    <label :for="headingId + '-password'">{{ $t("Password") }}</label>
                </div>

                <div v-if="tokenRequired">
                    <div class="form-floating mt-3">
                        <input
                            :id="headingId + '-otp'"
                            ref="otpInput"
                            v-model="token"
                            type="text"
                            maxlength="6"
                            inputmode="numeric"
                            name="otp"
                            class="form-control"
                            placeholder="123456"
                            autocomplete="one-time-code"
                            required
                        />
                        <label :for="headingId + '-otp'">{{ $t("Token") }}</label>
                    </div>
                </div>

                <div class="form-check my-3">
                    <input
                        :id="headingId + '-remember'"
                        v-model="$root.remember"
                        type="checkbox"
                        class="form-check-input"
                    />
                    <label class="form-check-label" :for="headingId + '-remember'">
                        {{ $t("Remember me") }}
                    </label>
                </div>
                <button
                    class="w-100 ws-button ws-button-primary justify-content-center"
                    type="submit"
                    :disabled="processing"
                >
                    {{ $t("Login") }}
                </button>

                <div v-if="res && !res.ok" class="alert alert-danger mt-3" role="alert">
                    {{ $t(res.msg) }}
                </div>
            </form>
        </div>
    </div>
</template>

<script>
import { useId } from "vue";

export default {
    props: {
        embedded: { type: Boolean, default: false },
    },
    setup() {
        return { headingId: useId() + "-login" };
    },
    data() {
        return {
            processing: false,
            username: "",
            password: "",
            token: "",
            res: null,
            tokenRequired: false,
        };
    },

    watch: {
        tokenRequired(newVal) {
            if (newVal) {
                this.$nextTick(() => {
                    this.$refs.otpInput?.focus();
                });
            }
        },
    },

    methods: {
        /**
         * Submit the user details and attempt to log in
         * @returns {void}
         */
        submit() {
            this.processing = true;
            this.res = null;

            this.$root.login(this.username, this.password, this.token, (res) => {
                this.processing = false;

                if (res.tokenRequired) {
                    this.tokenRequired = true;
                } else {
                    this.res = res;
                }
            });
        },
    },
};
</script>
