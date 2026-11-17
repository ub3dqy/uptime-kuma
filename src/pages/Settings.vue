<template>
    <div class="workspace-settings-page">
        <div v-if="$root.isMobile && !currentPage" class="settings-shortcuts mb-3">
            <router-link to="/clients" class="nav-link">
                <font-awesome-icon icon="folder" />
                {{ $t("clientGroupsTitle") }}
            </router-link>
            <router-link to="/manage-status-page" class="nav-link">
                <font-awesome-icon icon="stream" />
                {{ $t("Status Pages") }}
            </router-link>
            <router-link to="/maintenance" class="nav-link">
                <font-awesome-icon icon="wrench" />
                {{ $t("Maintenance") }}
            </router-link>
        </div>

        <router-link v-if="$root.isMobile && currentPage" to="/settings" class="ws-button ws-button-quiet mb-3">
            <font-awesome-icon icon="chevron-down" rotation="90" aria-hidden="true" />
            {{ $t("Settings") }}
        </router-link>
        <h1 v-if="!$root.isMobile || !currentPage" class="mb-3">
            {{ $t("Settings") }}
        </h1>

        <div class="settings-layout" :class="{ 'with-menu': showSubMenu }">
            <nav v-if="showSubMenu" class="settings-menu" :aria-label="$t('Settings')">
                <router-link v-if="$root.projectAccess.installationAdmin" to="/start">
                    <div class="menu-item">{{ $t("startTitle") }}</div>
                </router-link>
                <router-link v-for="(item, key) in subMenus" :key="key" :to="`/settings/${key}`">
                    <div class="menu-item">
                        {{ item.title }}
                    </div>
                </router-link>

                <button
                    v-if="$root.isMobile && $root.loggedIn && $root.socket.token !== 'autoLogin'"
                    type="button"
                    class="menu-item logout"
                    @click="$root.logout"
                >
                    <font-awesome-icon icon="sign-out-alt" aria-hidden="true" />
                    {{ $t("Logout") }}
                </button>
            </nav>
            <section v-if="currentPage" class="settings-content">
                <component :is="$root.isMobile ? 'h1' : 'h2'" class="settings-content-header">
                    {{ subMenus[currentPage].title }}
                </component>
                <div class="settings-content-body">
                    <router-view v-slot="{ Component }">
                        <transition name="slide-fade" mode="out-in">
                            <component :is="Component" />
                        </transition>
                    </router-view>
                </div>
            </section>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            settings: {},
            settingsLoaded: false,
        };
    },

    computed: {
        currentPage() {
            let pathSplit = this.$route.path.split("/");
            let pathEnd = pathSplit[pathSplit.length - 1];
            if (!Object.hasOwn(this.subMenus, pathEnd)) {
                return null;
            }
            return pathEnd;
        },

        showSubMenu() {
            if (this.$root.isMobile) {
                return !this.currentPage;
            } else {
                return true;
            }
        },

        subMenus() {
            return {
                general: {
                    title: this.$t("General"),
                },
                appearance: {
                    title: this.$t("Appearance"),
                },
                notifications: {
                    title: this.$t("Notifications"),
                },
                "reverse-proxy": {
                    title: this.$t("Reverse Proxy"),
                },
                tags: {
                    title: this.$t("Tags"),
                },
                "monitor-history": {
                    title: this.$t("Monitor History"),
                },
                "docker-hosts": {
                    title: this.$t("Docker Hosts"),
                },
                "remote-browsers": {
                    title: this.$t("Remote Browsers"),
                },
                security: {
                    title: this.$t("Security"),
                },
                "api-keys": {
                    title: this.$t("API Keys"),
                },
                proxies: {
                    title: this.$t("Proxies"),
                },
                about: {
                    title: this.$t("About"),
                },
            };
        },
    },

    watch: {
        "$root.isMobile"() {
            this.loadGeneralPage();
        },
    },

    mounted() {
        this.loadSettings();
        this.loadGeneralPage();
    },

    methods: {
        /**
         * Load the general settings page
         * For desktop only, on mobile do nothing
         * @returns {void}
         */
        loadGeneralPage() {
            if (!this.currentPage && !this.$root.isMobile) {
                this.$router.push("/settings/general");
            }
        },

        /**
         * Load settings from server
         * @returns {void}
         */
        loadSettings() {
            this.$root.getSocket().emit("getSettings", (res) => {
                this.settings = res.data;

                if (this.settings.checkUpdate === undefined) {
                    this.settings.checkUpdate = true;
                }

                if (this.settings.searchEngineIndex === undefined) {
                    this.settings.searchEngineIndex = false;
                }

                if (this.settings.entryPage === undefined) {
                    this.settings.entryPage = "dashboard";
                }

                if (this.settings.nscd === undefined) {
                    this.settings.nscd = true;
                }

                if (this.settings.keepDataPeriodDays === undefined) {
                    this.settings.keepDataPeriodDays = 180;
                }

                if (this.settings.tlsExpiryNotifyDays === undefined) {
                    this.settings.tlsExpiryNotifyDays = [7, 14, 21];
                }

                if (this.settings.domainExpiryNotifyDays === undefined) {
                    this.settings.domainExpiryNotifyDays = [7, 14, 21];
                }

                if (this.settings.trustProxy === undefined) {
                    this.settings.trustProxy = false;
                }

                this.settingsLoaded = true;
            });
        },

        /**
         * Callback for saving settings
         * @callback saveSettingsCB
         * @param {object} res Result of operation
         * @returns {void}
         */

        /**
         * Save Settings
         * @param {saveSettingsCB} callback Callback for socket response
         * @param {string} currentPassword Only need for disableAuth to true
         * @returns {void}
         */
        saveSettings(callback, currentPassword) {
            let valid = this.validateSettings();
            if (valid.success) {
                this.$root.getSocket().emit("setSettings", this.settings, currentPassword, (res) => {
                    this.$root.toastRes(res);
                    this.loadSettings();

                    if (callback) {
                        callback();
                    }
                });
            } else {
                this.$root.toastError(valid.msg);
            }
        },

        /**
         * Ensure settings are valid
         * @returns {object} Contains success state and error msg
         */
        validateSettings() {
            if (this.settings.keepDataPeriodDays < 0) {
                return {
                    success: false,
                    msg: this.$t("dataRetentionTimeError"),
                };
            }
            return {
                success: true,
                msg: "",
            };
        },
    },
};
</script>

<style lang="scss" scoped>
.settings-layout {
    display: grid;
    align-items: start;
    gap: 16px;
    grid-template-columns: minmax(0, 1fr);
}

@media (min-width: 768px) {
    .settings-layout.with-menu {
        grid-template-columns: minmax(168px, 225px) minmax(0, 1fr);
    }
}

.settings-shortcuts,
.settings-menu,
.settings-content {
    min-width: 0;
    border: 1px solid var(--ws-border);
    border-radius: 14px;
    background: var(--ws-surface);
    box-shadow: var(--ws-shadow);
}

.settings-shortcuts,
.settings-menu {
    padding: 8px;
}

.settings-menu a {
    display: block;
    border-radius: 8px;
    text-decoration: none;
    color: var(--ws-ink);
}

.settings-shortcuts .nav-link,
.settings-menu .menu-item {
    min-height: 44px;
    padding: 10px 12px;
    overflow-wrap: anywhere;
}

.settings-shortcuts .nav-link:hover,
.settings-menu a:hover,
.settings-menu a[aria-current="page"] {
    border-radius: 8px;
    color: var(--ws-action);
    background: var(--ws-action-soft);
}

.settings-menu a[aria-current="page"] {
    font-weight: 700;
}

.settings-content-header {
    margin: 0;
    padding: 16px clamp(14px, 3vw, 26px);
    border-bottom: 1px solid var(--ws-border);
    font-size: clamp(20px, 3vw, 26px);
    font-weight: 700;
}

.settings-content-body {
    padding: 0 clamp(14px, 3vw, 26px) 20px;
}

.logout {
    width: 100%;
    border: 0;
    border-top: 1px solid var(--ws-border);
    color: var(--ws-danger);
    background: transparent;
    text-align: start;
}
</style>
