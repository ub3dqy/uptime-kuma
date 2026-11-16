<template>
    <!-- Group List -->
    <Draggable v-model="$root.publicGroupList" :disabled="!editMode" item-key="id">
        <template #item="group">
            <div class="public-group mb-4" data-testid="group">
                <div class="group-heading">
                    <font-awesome-icon
                        v-if="editMode && showGroupDrag"
                        icon="arrows-alt-v"
                        class="drag"
                        aria-hidden="true"
                    />
                    <button
                        v-if="editMode"
                        type="button"
                        class="group-control remove"
                        :aria-label="$t('workspaceRemoveItem', { name: group.element.name })"
                        @click="removeGroup(group.index)"
                    >
                        <font-awesome-icon icon="times" aria-hidden="true" />
                    </button>
                    <button
                        v-if="editMode"
                        type="button"
                        class="group-control"
                        :aria-expanded="!isGroupCollapsed(group.element)"
                        :aria-label="
                            $t(isGroupCollapsed(group.element) ? 'workspaceShowGroup' : 'workspaceHideGroup', {
                                name: group.element.name,
                            })
                        "
                        @click="toggleGroup(group.element)"
                    >
                        <font-awesome-icon
                            icon="chevron-down"
                            class="chevron"
                            :class="{ collapsed: isGroupCollapsed(group.element) }"
                            aria-hidden="true"
                        />
                    </button>
                    <h2 class="group-title">
                        <Editable
                            v-if="editMode"
                            v-model="group.element.name"
                            :contenteditable="true"
                            tag="span"
                            data-testid="group-name"
                            :aria-label="$t('Name')"
                        />
                        <button
                            v-else
                            type="button"
                            class="group-control group-label"
                            :aria-expanded="!isGroupCollapsed(group.element)"
                            data-testid="group-name"
                            @click="toggleGroup(group.element)"
                        >
                            <font-awesome-icon
                                icon="chevron-down"
                                class="chevron"
                                :class="{ collapsed: isGroupCollapsed(group.element) }"
                                aria-hidden="true"
                            />
                            <span>{{ group.element.name }}</span>
                        </button>
                    </h2>
                </div>

                <transition name="slide-fade-up">
                    <div v-if="!isGroupCollapsed(group.element)" class="shadow-box monitor-list position-relative">
                        <div v-if="group.element.monitorList.length === 0" class="text-center no-monitor-msg">
                            {{ $t("No Monitors") }}
                        </div>

                        <!-- Monitor List -->
                        <Draggable
                            v-model="group.element.monitorList"
                            class="monitor-list"
                            group="same-group"
                            :disabled="!editMode"
                            item-key="id"
                        >
                            <template #item="monitor">
                                <div class="item" data-testid="monitor">
                                    <div class="monitor-row">
                                        <div class="monitor-meta">
                                            <div class="info">
                                                <font-awesome-icon
                                                    v-if="editMode"
                                                    icon="arrows-alt-v"
                                                    class="drag"
                                                    aria-hidden="true"
                                                />
                                                <button
                                                    v-if="editMode"
                                                    type="button"
                                                    class="group-control remove"
                                                    :aria-label="
                                                        $t('workspaceRemoveItem', { name: monitor.element.name })
                                                    "
                                                    @click="removeMonitor(group.index, monitor.index)"
                                                >
                                                    <font-awesome-icon icon="times" aria-hidden="true" />
                                                </button>

                                                <button
                                                    v-if="editMode"
                                                    type="button"
                                                    class="group-control"
                                                    :aria-label="
                                                        $t('workspaceEditItem', { name: monitor.element.name })
                                                    "
                                                    data-testid="monitor-settings"
                                                    @click="$refs.monitorSettingDialog.show(group, monitor)"
                                                >
                                                    <font-awesome-icon icon="cog" aria-hidden="true" />
                                                </button>
                                                <Status
                                                    v-if="showOnlyLastHeartbeat"
                                                    :status="statusOfLastHeartbeat(monitor.element.id)"
                                                />
                                                <Uptime v-else :monitor="monitor.element" type="24" :pill="true" />
                                                <a
                                                    v-if="showLink(monitor)"
                                                    :href="monitor.element.url"
                                                    class="item-name"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    data-testid="monitor-name"
                                                >
                                                    {{ monitor.element.name }}
                                                </a>
                                                <p v-else class="item-name" data-testid="monitor-name">
                                                    {{ monitor.element.name }}
                                                </p>
                                            </div>
                                            <div class="extra-info">
                                                <div
                                                    v-if="
                                                        showCertificateExpiry && monitor.element.certExpiryDaysRemaining
                                                    "
                                                >
                                                    <Tag
                                                        :item="{
                                                            name: $t('Cert Exp.'),
                                                            value: formattedCertExpiryMessage(monitor),
                                                            color: certExpiryColor(monitor),
                                                        }"
                                                        :size="'sm'"
                                                    />
                                                </div>
                                                <div v-if="showTags">
                                                    <Tag
                                                        v-for="tag in monitor.element.tags"
                                                        :key="tag"
                                                        :item="tag"
                                                        :size="'sm'"
                                                        data-testid="monitor-tag"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                        <div :key="$root.userHeartbeatBar" class="monitor-history">
                                            <HeartbeatBar size="mid" :monitor-id="monitor.element.id" />
                                        </div>
                                    </div>
                                </div>
                            </template>
                        </Draggable>
                    </div>
                </transition>
            </div>
        </template>
    </Draggable>
    <MonitorSettingDialog ref="monitorSettingDialog" />
</template>

<script>
import MonitorSettingDialog from "./MonitorSettingDialog.vue";
import Draggable from "vuedraggable";
import HeartbeatBar from "./HeartbeatBar.vue";
import Uptime from "./Uptime.vue";
import Tag from "./Tag.vue";
import Status from "./Status.vue";

export default {
    components: {
        MonitorSettingDialog,
        Draggable,
        HeartbeatBar,
        Uptime,
        Tag,
        Status,
    },
    props: {
        /** Are we in edit mode? */
        editMode: {
            type: Boolean,
            required: true,
        },
        /** Should tags be shown? */
        showTags: {
            type: Boolean,
        },
        /** Should expiry be shown? */
        showCertificateExpiry: {
            type: Boolean,
        },
        /** Should only the last heartbeat be shown? */
        showOnlyLastHeartbeat: {
            type: Boolean,
        },
    },
    data() {
        return {};
    },
    computed: {
        showGroupDrag() {
            return this.$root.publicGroupList.length >= 2;
        },
    },
    methods: {
        /**
         * Toggle collapsed state for a group
         * @param {object} group Group to toggle
         * @returns {void}
         */
        toggleGroup(group) {
            if (!this.$router) {
                return;
            }

            const groupId = this.getGroupIdentifier(group);
            const collapsed = this.getCollapsedList();
            const index = collapsed.indexOf(groupId);

            if (index >= 0) {
                collapsed.splice(index, 1);
            } else {
                collapsed.push(groupId);
            }

            const query = { ...this.$route.query };
            if (collapsed.length > 0) {
                query.collapse = collapsed;
            } else {
                delete query.collapse;
            }

            this.$router.push({ query }).catch(() => {});
        },

        /**
         * Check if a group is collapsed
         * @param {object} group Group to check
         * @returns {boolean} Whether the group is collapsed
         */
        isGroupCollapsed(group) {
            return this.getCollapsedList().includes(this.getGroupIdentifier(group));
        },

        /**
         * Get list of collapsed group identifiers from the query param.
         * Vue Router normalises repeated params (?collapse=1&collapse=2) into an array.
         * @returns {string[]} Collapsed group identifiers
         */
        getCollapsedList() {
            const raw = this.$route.query.collapse;
            if (!raw) {
                return [];
            }
            // Normalise to array: a single query param is a string, repeated params are already an array
            return [].concat(raw);
        },

        /**
         * Remove the specified group
         * @param {number} index Index of group to remove
         * @returns {void}
         */
        removeGroup(index) {
            this.$root.publicGroupList.splice(index, 1);
        },

        /**
         * Remove a monitor from a group
         * @param {number} groupIndex Index of group to remove monitor from
         * @param {number} index Index of monitor to remove
         * @returns {void}
         */
        removeMonitor(groupIndex, index) {
            this.$root.publicGroupList[groupIndex].monitorList.splice(index, 1);
        },

        /**
         * Should a link to the monitor be shown?
         * Attempts to guess if a link should be shown based upon if
         * sendUrl is set and if the URL is default or not.
         * @param {object} monitor Monitor to check
         * @param {boolean} ignoreSendUrl Should the presence of the sendUrl
         * property be ignored. This will only work in edit mode.
         * @returns {boolean} Should the link be shown
         */
        showLink(monitor, ignoreSendUrl = false) {
            // We must check if there are any elements in monitorList to
            // prevent undefined errors if it hasn't been loaded yet
            if (this.$parent.editMode && ignoreSendUrl && Object.keys(this.$root.monitorList).length) {
                return (
                    this.$root.monitorList[monitor.element.id].type === "http" ||
                    this.$root.monitorList[monitor.element.id].type === "keyword" ||
                    this.$root.monitorList[monitor.element.id].type === "json-query"
                );
            }
            return monitor.element.sendUrl && monitor.element.url && monitor.element.url !== "https://";
        },

        /**
         * Returns formatted certificate expiry or Bad cert message
         * @param {object} monitor Monitor to show expiry for
         * @returns {string} Certificate expiry message
         */
        formattedCertExpiryMessage(monitor) {
            if (monitor?.element?.validCert && monitor?.element?.certExpiryDaysRemaining) {
                return this.$t("days", monitor.element.certExpiryDaysRemaining);
            } else if (monitor?.element?.validCert === false) {
                return this.$t("noOrBadCertificate");
            } else {
                return this.$t("unknownDays");
            }
        },

        /**
         * Returns the status of the last heartbeat
         * @param {number} monitorId Id of the monitor to get status for
         * @returns {number} Status of the last heartbeat
         */
        statusOfLastHeartbeat(monitorId) {
            let heartbeats = this.$root.heartbeatList[monitorId] ?? [];
            let lastHeartbeat = heartbeats[heartbeats.length - 1];
            return lastHeartbeat?.status;
        },

        /**
         * Returns certificate expiry color based on days remaining
         * @param {object} monitor Monitor to show expiry for
         * @returns {string} Color for certificate expiry
         */
        certExpiryColor(monitor) {
            if (monitor?.element?.validCert && monitor.element.certExpiryDaysRemaining > 7) {
                return "#059669";
            }
            return "#DC2626";
        },

        /**
         * Get unique identifier for a group
         * @param {object} group object
         * @returns {string} group identifier
         */
        getGroupIdentifier(group) {
            if (group.id !== undefined && group.id !== null) {
                return group.id.toString();
            }
            return `group${this.$root.publicGroupList.indexOf(group)}`;
        },
    },
};
</script>

<style lang="scss" scoped>
.extra-info {
    display: flex;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
}

.extra-info > div > :deep(div:first-child) {
    margin-left: 0 !important;
}

.no-monitor-msg {
    position: absolute;
    width: 100%;
    top: 20px;
    left: 0;
}

.monitor-list {
    min-height: 46px;
}

.monitor-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 0.72fr);
    align-items: center;
    gap: 12px;
    padding: 8px 4px;
}

.monitor-meta .info,
.group-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.monitor-list .item .monitor-meta .info {
    min-width: 0;
    overflow: visible;
    white-space: normal;
}

.public-group > .monitor-list {
    border: 1px solid var(--ws-border);
    padding: 10px 12px;
}

.item-name {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
}

.drag {
    color: var(--ws-muted);
    cursor: grab;
}

.group-title {
    margin: 0;
    font-size: clamp(17px, 3vw, 23px);
    font-weight: 680;
    overflow-wrap: anywhere;
}

.group-control {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    gap: 10px;
    padding: 5px 7px;
    border: 0;
    border-radius: 8px;
    color: var(--ws-ink);
    background: transparent;
    text-align: start;
}

.group-control:hover {
    background: var(--ws-action-soft);
    color: var(--ws-action);
}

.group-control.remove {
    color: var(--ws-danger);
}

.chevron {
    flex: 0 0 auto;
    font-size: 0.72em;
    color: var(--ws-muted);
    transition: transform 180ms ease;

    &.collapsed {
        transform: rotate(-90deg);
    }
}

@media (max-width: 620px) {
    .monitor-row {
        grid-template-columns: minmax(0, 1fr);
        gap: 4px;
    }

    .monitor-history {
        min-width: 0;
    }
}
</style>
