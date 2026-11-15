<template>
    <div class="workspace-shell" :class="classes">
        <a class="workspace-skip" href="#workspace-main">{{ $t("workspaceSkipContent") }}</a>
        <div
            v-if="!$root.socket.connected && !$root.socket.firstConnect"
            class="workspace-connection-banner"
            role="status"
        >
            {{ $t("workspaceConnectionLost") }}
        </div>
        <header class="workspace-header">
            <router-link :to="$root.projectAccess.projectOnly ? '/projects' : '/dashboard'" class="workspace-brand">
                <img src="/icon.svg" width="35" height="35" alt="" />
                <span>Uptime Kuma</span>
            </router-link>
            <nav
                v-if="$root.loggedIn && !$root.isMobile && !$root.projectAccess.projectOnly"
                :aria-label="$t('workspaceMainNavigation')"
            >
                <ul class="workspace-nav">
                    <li>
                        <router-link to="/dashboard" class="workspace-nav-link">
                            <WorkspaceIcon name="overview" />
                            {{ $t("workspaceNavOverview") }}
                        </router-link>
                    </li>
                    <li>
                        <router-link to="/list" class="workspace-nav-link">
                            <WorkspaceIcon name="monitors" />
                            {{ $t("workspaceNavServices") }}
                        </router-link>
                    </li>
                    <li>
                        <router-link to="/notifications" class="workspace-nav-link">
                            <WorkspaceIcon name="alerts" />
                            {{ $t("workspaceNavAlerts") }}
                        </router-link>
                    </li>
                    <li>
                        <router-link to="/clients" class="workspace-nav-link">
                            <WorkspaceIcon name="reports" />
                            {{ $t("workspaceNavReports") }}
                        </router-link>
                    </li>
                </ul>
            </nav>
            <router-link
                v-if="$root.loggedIn"
                to="/projects"
                class="ws-button ws-button-quiet workspace-project-link"
                :aria-label="$t('projectTitle')"
            >
                <WorkspaceIcon name="reports" />
                <span>{{ $t("projectTitle") }}</span>
            </router-link>
            <div v-if="$root.loggedIn" class="dropdown">
                <button
                    class="workspace-account"
                    type="button"
                    data-bs-toggle="dropdown"
                    aria-expanded="false"
                    :aria-label="$t('workspaceAccount')"
                >
                    <span class="workspace-account-avatar">{{ $root.usernameFirstChar }}</span>
                </button>
                <ul class="dropdown-menu dropdown-menu-end">
                    <li>
                        <i18n-t
                            v-if="$root.username != null"
                            tag="span"
                            keypath="signedInDisp"
                            class="dropdown-item-text"
                        >
                            <strong>{{ $root.username }}</strong>
                        </i18n-t>
                        <span v-else class="dropdown-item-text">{{ $t("signedInDispDisabled") }}</span>
                    </li>
                    <li><hr class="dropdown-divider" /></li>
                    <li>
                        <router-link to="/projects" class="dropdown-item">{{ $t("projectTitle") }}</router-link>
                    </li>
                    <li>
                        <router-link to="/account" class="dropdown-item">{{ $t("projectMyAccount") }}</router-link>
                    </li>
                    <template v-if="!$root.projectAccess.projectOnly">
                        <li>
                            <router-link to="/settings/general" class="dropdown-item">{{ $t("Settings") }}</router-link>
                        </li>
                        <li>
                            <router-link to="/maintenance" class="dropdown-item">{{ $t("Maintenance") }}</router-link>
                        </li>
                        <li>
                            <router-link to="/manage-status-page" class="dropdown-item">
                                {{ $t("Status Pages") }}
                            </router-link>
                        </li>
                        <li>
                            <router-link to="/events" class="dropdown-item">
                                {{ $t("workspaceEventHistory") }}
                            </router-link>
                        </li>
                        <li>
                            <router-link to="/settings/about" class="dropdown-item">{{ $t("About") }}</router-link>
                        </li>
                        <li>
                            <a
                                href="https://github.com/ub3dqy/uptime-kuma"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="dropdown-item"
                            >
                                {{ $t("workspaceSource") }}
                            </a>
                        </li>
                    </template>
                    <li v-if="$root.socket.token !== 'autoLogin'">
                        <button class="dropdown-item" type="button" @click="$root.logout">{{ $t("Logout") }}</button>
                    </li>
                </ul>
            </div>
        </header>
        <main id="workspace-main" class="workspace-main" tabindex="-1">
            <router-view v-if="$root.loggedIn" />
            <Login v-if="!$root.loggedIn && $root.allowLoginDialog" />
        </main>
        <nav
            v-if="$root.isMobile && $root.loggedIn && !$root.projectAccess.projectOnly"
            class="workspace-mobile-nav"
            :aria-label="$t('workspaceMainNavigation')"
        >
            <router-link to="/dashboard">
                <WorkspaceIcon name="overview" />
                {{ $t("workspaceNavOverview") }}
            </router-link>
            <router-link to="/list">
                <WorkspaceIcon name="monitors" />
                {{ $t("workspaceNavServices") }}
            </router-link>
            <router-link to="/notifications">
                <WorkspaceIcon name="alerts" />
                {{ $t("workspaceNavAlerts") }}
            </router-link>
            <router-link to="/clients">
                <WorkspaceIcon name="reports" />
                {{ $t("workspaceNavReports") }}
            </router-link>
            <router-link to="/settings">
                <WorkspaceIcon name="settings" />
                {{ $t("Settings") }}
            </router-link>
        </nav>
        <button
            v-if="numActiveToasts"
            type="button"
            class="btn btn-normal clear-all-toast-btn"
            :aria-label="$t('Close')"
            @click="clearToasts"
        >
            <WorkspaceIcon name="close" />
        </button>
    </div>
</template>

<script>
import Login from "../components/Login.vue";
import WorkspaceIcon from "../components/WorkspaceIcon.vue";
import { useToast } from "../notifications";
const toast = useToast();

export default {
    components: { Login, WorkspaceIcon },
    data() {
        return { numActiveToasts: 0, toastContainerObserver: null };
    },
    computed: {
        classes() {
            return { [this.$root.theme]: true, mobile: this.$root.isMobile };
        },
    },
    watch: {
        "$route.path": "protectProjectRoute",
        "$root.projectAccess.projectOnly": "protectProjectRoute",
        "$root.loggedIn": "protectProjectRoute",
    },
    mounted() {
        const container = document.querySelector(".bottom-right.toast-container");
        if (container) {
            this.toastContainerObserver = new MutationObserver(() => {
                this.numActiveToasts = container.children.length;
            });
            this.toastContainerObserver.observe(container, { childList: true });
        }
    },
    beforeUnmount() {
        this.toastContainerObserver?.disconnect();
    },
    methods: {
        /** @returns {void} Participants stay inside their authorized project workspace */
        protectProjectRoute() {
            if (
                this.$root.loggedIn &&
                this.$root.projectAccess.projectOnly &&
                !this.$route.path.startsWith("/projects") &&
                this.$route.path !== "/account"
            ) {
                this.$router.replace("/projects");
            }
        },
        /**
         * Clear the existing application's toast notifications.
         * @returns {void}
         */
        clearToasts() {
            toast.clear();
        },
    },
};
</script>

<style scoped>
.clear-all-toast-btn {
    position: fixed;
    right: 18px;
    bottom: 88px;
    z-index: 1100;
}
</style>
