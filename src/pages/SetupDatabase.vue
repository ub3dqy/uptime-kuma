<template>
    <main class="workspace-shell ws-access" :class="{ dark: $root.isDark }">
        <form
            v-if="show"
            class="ws-access-panel ws-access-panel-wide"
            aria-labelledby="database-setup-title"
            @submit.prevent="submit"
        >
            <header class="ws-access-heading">
                <span class="workspace-brand">
                    <img width="32" height="32" src="/images/kuma-pulse.png" alt="" />
                    Uptime Kuma
                </span>
                <h1 id="database-setup-title">{{ $t("setupDatabaseChooseDatabase") }}</h1>
            </header>

            <div v-if="info.runningSetup">
                <div class="alert alert-success mb-0" role="status">
                    <div class="d-flex align-items-center">
                        <strong>{{ $t("settingUpDatabaseMSG") }}</strong>
                        <div class="ms-3 pt-1">
                            <div class="spinner-border" aria-hidden="true"></div>
                        </div>
                    </div>
                </div>
            </div>

            <template v-if="!info.runningSetup">
                <div class="form-floating">
                    <select id="language" v-model="$root.language" class="form-select">
                        <option v-for="(lang, i) in $i18n.availableLocales" :key="`Lang${i}`" :value="lang">
                            {{ $i18n.messages[lang].languageName }}
                        </option>
                    </select>
                    <label for="language" class="form-label">{{ $t("Language") }}</label>
                </div>

                <div class="db-choices mt-3" role="radiogroup" aria-labelledby="database-setup-title">
                    <template v-if="info.isEnabledEmbeddedMariaDB">
                        <input
                            id="btnradio3"
                            v-model="dbConfig.type"
                            type="radio"
                            class="btn-check"
                            name="database-type"
                            autocomplete="off"
                            value="embedded-mariadb"
                        />

                        <label class="btn btn-outline-primary" for="btnradio3">Embedded MariaDB</label>
                    </template>

                    <input
                        id="btnradio2"
                        v-model="dbConfig.type"
                        type="radio"
                        class="btn-check"
                        name="database-type"
                        autocomplete="off"
                        value="mariadb"
                    />
                    <label class="btn btn-outline-primary" for="btnradio2">MariaDB / MySQL</label>

                    <input
                        id="btnradio1"
                        v-model="dbConfig.type"
                        type="radio"
                        class="btn-check"
                        name="database-type"
                        autocomplete="off"
                        value="sqlite"
                    />
                    <label class="btn btn-outline-primary" for="btnradio1">SQLite</label>
                </div>

                <div v-if="dbConfig.type === 'embedded-mariadb'" class="mt-3">
                    {{ $t("setupDatabaseEmbeddedMariaDB") }}
                </div>

                <div v-if="dbConfig.type === 'mariadb'" class="mt-3">
                    {{ $t("setupDatabaseMariaDB") }}
                </div>

                <div v-if="dbConfig.type === 'sqlite'" class="mt-3">
                    {{ $t("setupDatabaseSQLite") }}
                </div>

                <template v-if="dbConfig.type === 'mariadb'">
                    <div v-if="!isProvidedMariaDBSocket" class="form-floating mt-3">
                        <input
                            id="database-hostname"
                            v-model="dbConfig.hostname"
                            type="text"
                            class="form-control"
                            placeholder=" "
                            required
                        />
                        <label for="database-hostname">{{ $t("Hostname") }}</label>
                    </div>

                    <div v-if="!isProvidedMariaDBSocket" class="form-floating mt-3">
                        <input
                            id="database-port"
                            v-model="dbConfig.port"
                            type="text"
                            inputmode="numeric"
                            placeholder=" "
                            class="form-control"
                            required
                        />
                        <label for="database-port">{{ $t("Port") }}</label>
                    </div>

                    <div v-if="isProvidedMariaDBSocket" class="mt-1 text-start">
                        <i18n-t keypath="mariadbSocketPathDetectedHelptext" tag="div" class="form-text">
                            <code>UPTIME_KUMA_DB_SOCKET</code>
                        </i18n-t>
                    </div>

                    <hr v-if="isProvidedMariaDBSocket" class="mt-3 mb-2" />

                    <div class="form-floating mt-3">
                        <input
                            id="database-username"
                            v-model="dbConfig.username"
                            type="text"
                            class="form-control"
                            placeholder=" "
                            required
                        />
                        <label for="database-username">{{ $t("Username") }}</label>
                    </div>

                    <div class="form-floating mt-3">
                        <input
                            id="database-password"
                            v-model="dbConfig.password"
                            type="password"
                            class="form-control"
                            placeholder=" "
                            required
                        />
                        <label for="database-password">{{ $t("Password") }}</label>
                    </div>

                    <div class="form-floating mt-3">
                        <input
                            id="database-name"
                            v-model="dbConfig.dbName"
                            type="text"
                            placeholder=" "
                            class="form-control"
                            required
                        />
                        <label for="database-name">{{ $t("dbName") }}</label>
                    </div>

                    <div class="mt-3 text-start">
                        <div class="form-check form-switch ps-0" style="height: auto; display: block; padding: 0">
                            <div class="d-flex align-items-center">
                                <input
                                    id="sslCheck"
                                    v-model="dbConfig.ssl"
                                    type="checkbox"
                                    role="switch"
                                    class="form-check-input ms-0 me-2"
                                    style="float: none"
                                />
                                <label class="form-check-label fw-bold" for="sslCheck">
                                    {{ $t("enableSSL") }}
                                    <span class="fw-normal text-muted" style="font-size: 0.9em">
                                        ({{ $t("Optional") }})
                                    </span>
                                </label>
                            </div>
                            <div class="form-text mt-1">
                                {{ $t("mariadbUseSSLHelptext") }}
                            </div>
                        </div>
                    </div>

                    <div v-if="dbConfig.ssl" class="form-floating mt-3">
                        <textarea
                            id="caInput"
                            v-model="dbConfig.ca"
                            class="form-control"
                            placeholder="-----BEGIN CERTIFICATE-----"
                            style="height: 120px"
                        ></textarea>
                        <label for="caInput">{{ $t("mariadbCaCertificateLabel") }}</label>
                        <div class="form-text">{{ $t("mariadbCaCertificateHelptext") }}</div>
                    </div>
                </template>

                <div class="mt-3 text-start">
                    <label for="database-setup-code" class="form-label">{{ $t("setupCode") }}</label>
                    <input
                        id="database-setup-code"
                        v-model.trim="code"
                        type="password"
                        name="setup-code"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                        maxlength="32"
                        class="form-control"
                        aria-describedby="database-setup-code-help"
                        required
                    />
                    <small id="database-setup-code-help" class="ws-channel-note">{{ $t("setupCodeHelp") }}</small>
                </div>
                <p v-if="error" class="ws-form-error mt-3" role="alert">{{ $t(error) }}</p>

                <button
                    class="w-100 ws-button ws-button-primary justify-content-center mt-4"
                    type="submit"
                    :disabled="disabledButton"
                >
                    {{ $t("Next") }}
                </button>
            </template>
        </form>
    </main>
</template>

<script>
import axios from "axios";
import { setupCodeFromLink } from "../setup-link";
import { sleep } from "../util.ts";

export default {
    data() {
        return {
            show: false,
            code: "",
            error: "",
            dbConfig: {
                type: undefined,
                port: 3306,
                hostname: "",
                username: "",
                password: "",
                dbName: "kuma",
                ssl: true,
                ca: "",
            },
            info: {
                needSetup: false,
                runningSetup: false,
                isEnabledEmbeddedMariaDB: false,
            },
        };
    },
    computed: {
        disabledButton() {
            return this.dbConfig.type === undefined || this.info.runningSetup;
        },
        isProvidedMariaDBSocket() {
            return this.info.isEnabledMariaDBSocket;
        },
    },
    watch: {
        "$route.hash": {
            immediate: true,
            handler(hash) {
                const code = setupCodeFromLink(hash);
                if (this.$route.path === "/setup-database" && code) {
                    this.code = code;
                    this.$router.replace({ hash: "" });
                }
            },
        },
    },
    async mounted() {
        try {
            const { data } = await axios.get("/setup-database-info", { timeout: 5000 });
            this.info = data;
            if (data.needSetup === false) {
                this.goToOwner();
            } else {
                this.show = true;
            }
        } catch {
            this.$router.replace("/setup");
        }
    },
    methods: {
        async submit() {
            this.info.runningSetup = true;
            this.error = "";
            try {
                await axios.post("/setup-database", { dbConfig: this.dbConfig, code: this.code }, { timeout: 15000 });
                for (let attempt = 0; attempt < 25; attempt++) {
                    await sleep(800);
                    try {
                        const { data } = await axios.get("/setup-database-info", { timeout: 1200 });
                        if (data.needSetup === false) {
                            this.goToOwner();
                            return;
                        }
                    } catch {
                        // The main panel is still starting.
                    }
                }
                this.error = "setupSaveFailed";
            } catch (error) {
                this.error = error.response?.data?.error || "setupSaveFailed";
            } finally {
                this.info.runningSetup = false;
            }
        },

        goToOwner() {
            const fragment = /^[A-Za-z0-9_-]{32}$/.test(this.code) ? "#code=" + this.code : "";
            window.location.replace("/setup" + fragment);
        },
    },
};
</script>

<style lang="scss" scoped>
.db-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.db-choices label {
    flex: 1 1 128px;
    display: flex;
    min-height: 48px;
    justify-content: center;
    align-items: center;
    border-color: var(--ws-control-border);
    color: var(--ws-ink);
    font-weight: 600;
    overflow-wrap: normal;
}

.db-choices :checked + label {
    border-color: var(--ws-action);
    color: var(--ws-action);
    background: var(--ws-action-soft);
}

.db-choices :focus-visible + label {
    outline: 3px solid #347bc4;
    outline-offset: 2px;
}
</style>
