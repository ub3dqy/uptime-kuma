<template>
    <transition name="slide-fade" appear>
        <div class="maintenance-page">
            <header class="maintenance-heading mb-3">
                <h1>{{ $t("Maintenance") }}</h1>
                <router-link to="/add-maintenance" class="ws-button ws-button-primary">
                    <font-awesome-icon icon="plus" aria-hidden="true" />
                    {{ $t("Schedule Maintenance") }}
                </router-link>
            </header>

            <div class="shadow-box">
                <span
                    v-if="Object.keys(sortedMaintenanceList).length === 0"
                    class="d-flex align-items-center justify-content-center my-3"
                >
                    {{ $t("No Maintenance") }}
                </span>

                <div v-for="item in sortedMaintenanceList" :key="item.id" class="item" :class="item.status">
                    <div class="left-part">
                        <div class="circle" aria-hidden="true"></div>
                        <div class="info">
                            <div class="title">{{ item.title }}</div>
                            <div class="maintenance-state">
                                {{ $t("maintenanceStatus-" + item.status) }}
                            </div>

                            <MaintenanceTime :maintenance="item" />
                        </div>
                    </div>

                    <div class="buttons">
                        <div class="maintenance-actions" role="group" :aria-label="item.title">
                            <button
                                v-if="item.active"
                                type="button"
                                class="ws-button ws-button-quiet"
                                :aria-label="$t('ariaPauseMaintenance')"
                                @click="pauseDialog(item.id)"
                            >
                                <font-awesome-icon icon="pause" />
                                {{ $t("Pause") }}
                            </button>

                            <button
                                v-if="!item.active"
                                type="button"
                                class="ws-button ws-button-primary"
                                :aria-label="$t('ariaResumeMaintenance')"
                                @click="resumeMaintenance(item.id)"
                            >
                                <font-awesome-icon icon="play" />
                                {{ $t("Resume") }}
                            </button>

                            <router-link
                                :to="'/maintenance/clone/' + item.id"
                                class="ws-button ws-button-quiet"
                                :aria-label="$t('ariaCloneMaintenance')"
                            >
                                <font-awesome-icon icon="clone" />
                                {{ $t("Clone") }}
                            </router-link>

                            <router-link
                                :to="'/maintenance/edit/' + item.id"
                                class="ws-button ws-button-quiet"
                                :aria-label="$t('ariaEditMaintenance')"
                            >
                                <font-awesome-icon icon="edit" />
                                {{ $t("Edit") }}
                            </router-link>

                            <button
                                type="button"
                                class="ws-button ws-button-quiet maintenance-delete"
                                :aria-label="$t('ariaDeleteMaintenance')"
                                @click="deleteDialog(item.id)"
                            >
                                <font-awesome-icon icon="trash" />
                                {{ $t("Delete") }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="text-center mt-3" style="font-size: 13px">
                <a href="https://github.com/louislam/uptime-kuma/wiki/Maintenance" target="_blank">
                    {{ $t("Learn More") }}
                </a>
            </div>

            <Confirm ref="confirmPause" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="pauseMaintenance">
                {{ $t("pauseMaintenanceMsg") }}
            </Confirm>

            <Confirm
                ref="confirmDelete"
                btn-style="btn-danger"
                :yes-text="$t('Yes')"
                :no-text="$t('No')"
                @yes="deleteMaintenance"
            >
                {{ $t("deleteMaintenanceMsg") }}
            </Confirm>
        </div>
    </transition>
</template>

<script>
import { getResBaseURL } from "../util-frontend";
import Confirm from "../components/Confirm.vue";
import MaintenanceTime from "../components/MaintenanceTime.vue";

export default {
    components: {
        MaintenanceTime,
        Confirm,
    },
    data() {
        return {
            selectedMaintenanceID: undefined,
            statusOrderList: {
                "under-maintenance": 1000,
                scheduled: 900,
                inactive: 800,
                ended: 700,
                unknown: 0,
            },
        };
    },
    computed: {
        sortedMaintenanceList() {
            let result = Object.values(this.$root.maintenanceList);

            result.sort((m1, m2) => {
                if (this.statusOrderList[m1.status] === this.statusOrderList[m2.status]) {
                    return m1.title.localeCompare(m2.title);
                } else {
                    return this.statusOrderList[m1.status] < this.statusOrderList[m2.status];
                }
            });

            return result;
        },
    },
    mounted() {},
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

        /**
         * Show delete confirmation
         * @param {number} maintenanceID ID of maintenance to show delete
         * confirmation for.
         * @returns {void}
         */
        deleteDialog(maintenanceID) {
            this.selectedMaintenanceID = maintenanceID;
            this.$refs.confirmDelete.show();
        },

        /**
         * Delete maintenance after showing confirmation dialog
         * @returns {void}
         */
        deleteMaintenance() {
            this.$root.deleteMaintenance(this.selectedMaintenanceID, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$router.push("/maintenance");
                }
            });
        },

        /**
         * Show dialog to confirm pause
         * @param {number} maintenanceID ID of maintenance to confirm
         * pause.
         * @returns {void}
         */
        pauseDialog(maintenanceID) {
            this.selectedMaintenanceID = maintenanceID;
            this.$refs.confirmPause.show();
        },

        /**
         * Pause maintenance
         * @returns {void}
         */
        pauseMaintenance() {
            this.$root.getSocket().emit("pauseMaintenance", this.selectedMaintenanceID, (res) => {
                this.$root.toastRes(res);
            });
        },

        /**
         * Resume maintenance
         * @param {number} id ID of maintenance to resume
         * @returns {void}
         */
        resumeMaintenance(id) {
            this.$root.getSocket().emit("resumeMaintenance", id, (res) => {
                this.$root.toastRes(res);
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.maintenance-page {
    padding: clamp(12px, 3vw, 24px);
}

.maintenance-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.maintenance-heading h1 {
    margin: 0;
}

.maintenance-page .shadow-box {
    padding: clamp(12px, 2.5vw, 24px);
    border: 1px solid var(--ws-border);
    background: var(--ws-surface);
    box-shadow: var(--ws-shadow);
}

.item {
    --maintenance-state: var(--ws-muted);

    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding-block: 16px;
    overflow-wrap: anywhere;
}

.item + .item {
    border-top: 1px solid var(--ws-border);
}

.item.under-maintenance {
    --maintenance-state: var(--trace-maintenance);
}

.item.scheduled {
    --maintenance-state: var(--ws-action);
}

.item.inactive {
    --maintenance-state: var(--ws-danger);
}

.left-part {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
}

.circle {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--maintenance-state);
}

.title {
    font-size: 17px;
    font-weight: 680;
}

.maintenance-state {
    color: var(--maintenance-state);
    font-size: 14px;
}

.maintenance-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.maintenance-actions .ws-button {
    padding-inline: 10px;
    font-size: 14px;
}

.maintenance-delete {
    color: var(--ws-danger);
}

@media (max-width: 640px) {
    .buttons {
        width: 100%;
    }

    .maintenance-actions {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(122px, 100%), 1fr));
    }
}
</style>
