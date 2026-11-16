<template>
    <transition name="slide-fade" appear>
        <div class="status-page-list">
            <header class="status-list-heading mb-3">
                <h1>{{ $t("Status Pages") }}</h1>
                <router-link to="/add-status-page" class="ws-button ws-button-primary">
                    <font-awesome-icon icon="plus" aria-hidden="true" />
                    {{ $t("New Status Page") }}
                </router-link>
            </header>

            <div class="shadow-box">
                <template v-if="$root.statusPageListLoaded">
                    <p
                        v-if="Object.keys($root.statusPageList).length === 0"
                        class="d-flex align-items-center justify-content-center my-3"
                    >
                        {{ $t("No status pages") }}
                    </p>

                    <div v-for="statusPage in $root.statusPageList" :key="statusPage.slug" class="item">
                        <!-- Reload to initialize the public heartbeat feed. -->
                        <a :href="'/status/' + statusPage.slug" class="status-page-link">
                            <img :src="icon(statusPage.icon)" alt="" width="42" height="42" class="logo" />
                            <div class="info">
                                <div class="title">{{ statusPage.title }}</div>
                                <div class="slug">/status/{{ statusPage.slug }}</div>
                            </div>
                        </a>
                        <button
                            type="button"
                            class="ws-button ws-button-quiet delete-status-page"
                            :aria-label="$t('workspaceDeleteStatusPage', { name: statusPage.title })"
                            @click="deleteDialog(statusPage.slug)"
                        >
                            <font-awesome-icon icon="trash" aria-hidden="true" />
                        </button>
                    </div>
                </template>
                <div v-else class="d-flex align-items-center justify-content-center my-3 spinner">
                    <font-awesome-icon icon="spinner" size="2x" spin />
                </div>
            </div>
        </div>
    </transition>
    <Confirm
        ref="confirmDelete"
        btn-style="btn-danger"
        :yes-text="$t('Yes')"
        :no-text="$t('No')"
        @yes="deleteStatusPage"
    >
        {{ $t("deleteStatusPageMsg") }}
    </Confirm>
</template>

<script>
import Confirm from "../components/Confirm.vue";
import { getResBaseURL } from "../util-frontend";

export default {
    components: {
        Confirm,
    },
    data() {
        return {
            selectedStatusSlug: "",
        };
    },
    methods: {
        /**
         * Get the correct URL for the icon
         * @param {string} icon Path for icon
         * @returns {string} Correctly formatted path including port numbers
         */
        icon(icon) {
            if (icon === "/icon.svg") {
                return icon;
            } else {
                return getResBaseURL() + icon;
            }
        },
        deleteDialog(slug) {
            this.$data.selectedStatusSlug = slug;
            this.$refs.confirmDelete.show();
        },
        deleteStatusPage() {
            this.$root.getSocket().emit("deleteStatusPage", this.$data.selectedStatusSlug, (res) => {
                if (res.ok) {
                    this.$root.toastSuccess(this.$t("successDeleted"));
                    window.location.reload();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.status-list-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
}

.status-list-heading h1 {
    margin: 0;
}

.status-page-list .shadow-box {
    border: 1px solid var(--ws-border);
    background: var(--ws-surface);
    box-shadow: var(--ws-shadow);
}

.item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding-block: 8px;
}

.item + .item {
    border-top: 1px solid var(--ws-border);
}

.status-page-link {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 8px;
    border-radius: 8px;
    text-decoration: none;
    color: var(--ws-ink);
    overflow-wrap: anywhere;
}

.status-page-link:hover {
    color: var(--ws-action);
    background: var(--ws-action-soft);
}

.logo {
    flex: 0 0 auto;
    border-radius: 8px;
    object-fit: contain;
}

.title {
    font-weight: 680;
}

.slug {
    color: var(--ws-muted);
    font-size: 13px;
}

.delete-status-page {
    min-width: 45px;
    padding-inline: 10px;
    color: var(--ws-danger);
}
</style>
