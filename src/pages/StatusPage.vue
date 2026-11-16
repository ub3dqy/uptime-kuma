<template>
    <NotFound v-if="notFound" />
    <div
        v-else-if="loadedTheme"
        class="workspace-shell status-workspace"
        :class="{ dark: $root.isDark, 'is-editing': enableEditMode }"
    >
        <!-- Sidebar for edit mode -->
        <aside v-if="enableEditMode" class="sidebar" data-testid="edit-sidebar" :aria-label="$t('Edit Status Page')">
            <h2 class="sidebar-title">{{ $t("Edit Status Page") }}</h2>
            <div class="sidebar-body">
                <div class="my-3">
                    <label for="slug" class="form-label">{{ $t("Slug") }}</label>
                    <div class="input-group">
                        <span id="basic-addon3" class="input-group-text">/status/</span>
                        <input id="slug" v-model="config.slug" type="text" class="form-control" />
                    </div>
                </div>

                <div class="my-3">
                    <label for="title" class="form-label">{{ $t("Title") }}</label>
                    <input id="title" v-model="config.title" type="text" class="form-control" />
                </div>

                <!-- Description -->
                <div class="my-3">
                    <label for="description" class="form-label">{{ $t("Description") }}</label>
                    <textarea
                        id="description"
                        v-model="config.description"
                        class="form-control"
                        data-testid="description-input"
                    ></textarea>
                    <div class="form-text">{{ $t("markdownSupported") }}</div>
                </div>

                <!-- Footer Text -->
                <div class="my-3">
                    <label for="footer-text" class="form-label">{{ $t("Footer Text") }}</label>
                    <textarea
                        id="footer-text"
                        v-model="config.footerText"
                        class="form-control"
                        data-testid="footer-text-input"
                    ></textarea>
                    <div class="form-text">{{ $t("markdownSupported") }}</div>
                </div>

                <div class="my-3">
                    <label for="auto-refresh-interval" class="form-label">{{ $t("Refresh Interval") }}</label>
                    <input
                        id="auto-refresh-interval"
                        v-model="config.autoRefreshInterval"
                        type="number"
                        class="form-control"
                        :min="5"
                        data-testid="refresh-interval-input"
                    />
                    <div class="form-text">
                        {{ $t("Refresh Interval Description", [config.autoRefreshInterval]) }}
                    </div>
                </div>

                <div class="my-3">
                    <label for="switch-theme" class="form-label">{{ $t("Theme") }}</label>
                    <select id="switch-theme" v-model="config.theme" class="form-select" data-testid="theme-select">
                        <option value="auto">{{ $t("Auto") }}</option>
                        <option value="light">{{ $t("Light") }}</option>
                        <option value="dark">{{ $t("Dark") }}</option>
                    </select>
                </div>

                <div class="my-3 form-check form-switch">
                    <input
                        id="showTags"
                        v-model="config.showTags"
                        class="form-check-input"
                        type="checkbox"
                        data-testid="show-tags-checkbox"
                    />
                    <label class="form-check-label" for="showTags">{{ $t("Show Tags") }}</label>
                </div>

                <!-- Show Powered By -->
                <div class="my-3 form-check form-switch">
                    <input
                        id="show-powered-by"
                        v-model="config.showPoweredBy"
                        class="form-check-input"
                        type="checkbox"
                        data-testid="show-powered-by-checkbox"
                    />
                    <label class="form-check-label" for="show-powered-by">{{ $t("Show Powered By") }}</label>
                </div>

                <!-- Show certificate expiry -->
                <div class="my-3 form-check form-switch">
                    <input
                        id="show-certificate-expiry"
                        v-model="config.showCertificateExpiry"
                        class="form-check-input"
                        type="checkbox"
                        data-testid="show-certificate-expiry-checkbox"
                    />
                    <label class="form-check-label" for="show-certificate-expiry">
                        {{ $t("showCertificateExpiry") }}
                    </label>
                </div>

                <!-- Show only last heartbeat -->
                <div class="my-3 form-check form-switch">
                    <input
                        id="show-only-last-heartbeat"
                        v-model="config.showOnlyLastHeartbeat"
                        class="form-check-input"
                        type="checkbox"
                    />
                    <label class="form-check-label" for="show-only-last-heartbeat">
                        {{ $t("showOnlyLastHeartbeat") }}
                    </label>
                </div>

                <!-- Domain Name List -->
                <div class="my-3">
                    <label class="form-label">
                        {{ $t("Domain Names") }}
                        <button
                            class="p-0 bg-transparent border-0"
                            :aria-label="$t('Add a domain')"
                            @click="addDomainField"
                        >
                            <font-awesome-icon icon="plus-circle" class="action text-primary" />
                        </button>
                    </label>

                    <ul class="list-group domain-name-list">
                        <li v-for="(domain, index) in config.domainNameList" :key="index" class="list-group-item">
                            <input
                                v-model="config.domainNameList[index]"
                                type="text"
                                class="no-bg domain-input"
                                placeholder="example.com"
                            />
                            <button
                                class="p-0 bg-transparent border-0"
                                :aria-label="$t('Remove domain', [domain])"
                                @click="removeDomain(index)"
                            >
                                <font-awesome-icon icon="times" class="action remove ms-2 me-3 text-danger" />
                            </button>
                        </li>
                    </ul>
                </div>

                <!-- Analytics -->

                <div class="my-3">
                    <label for="analyticsType" class="form-label">{{ $t("Analytics Type") }}</label>
                    <select
                        id="analyticsType"
                        v-model="config.analyticsType"
                        class="form-select"
                        data-testid="analytics-type-select"
                    >
                        <option :value="null">{{ $t("None") }}</option>
                        <option value="google">Google</option>
                        <option value="umami">Umami</option>
                        <option value="plausible">Plausible</option>
                        <option value="matomo">Matomo</option>
                        <option value="rybbit">Rybbit</option>
                    </select>
                </div>

                <div v-if="!!config.analyticsType" class="my-3">
                    <label for="analyticsId" class="form-label">{{ $t("Analytics ID") }}</label>
                    <input
                        id="analyticsId"
                        v-model="config.analyticsId"
                        type="text"
                        class="form-control"
                        data-testid="analytics-id-input"
                    />
                </div>

                <div v-if="!!config.analyticsType && config.analyticsType !== 'google'" class="my-3">
                    <label for="analyticsScriptUrl" class="form-label">{{ $t("Analytics Script URL") }}</label>
                    <input
                        id="analyticsScriptUrl"
                        v-model="config.analyticsScriptUrl"
                        type="url"
                        class="form-control"
                        data-testid="analytics-script-url-input"
                    />
                </div>

                <!-- RSS Title -->
                <div class="my-3">
                    <label for="rss-title" class="form-label">{{ $t("RSS Title") }}</label>
                    <input
                        id="rss-title"
                        v-model="config.rssTitle"
                        type="text"
                        class="form-control"
                        data-testid="rss-title-input"
                    />
                    <div class="form-text">
                        {{ $t("Leave blank to use status page title") }}
                    </div>
                </div>

                <!-- Custom CSS -->
                <div class="my-3">
                    <div class="mb-1">{{ $t("Custom CSS") }}</div>
                    <code-editor
                        v-model="config.customCSS"
                        class="css-editor"
                        data-testid="custom-css-input"
                        language="css"
                        line-numbers
                    ></code-editor>
                </div>

                <div class="danger-zone">
                    <button class="btn btn-danger me-2" @click="deleteDialog">
                        <font-awesome-icon icon="trash" />
                        {{ $t("Delete") }}
                    </button>
                </div>
            </div>

            <!-- Sidebar Footer -->
            <div class="sidebar-footer">
                <button
                    type="button"
                    class="ws-button ws-button-primary"
                    :disabled="loading || !editMode"
                    data-testid="save-button"
                    @click="save"
                >
                    <font-awesome-icon icon="save" />
                    {{ $t("Save") }}
                </button>

                <button type="button" class="ws-button ws-button-quiet" @click="discard">
                    <font-awesome-icon icon="undo" />
                    {{ $t("Discard") }}
                </button>
            </div>
        </aside>

        <!-- Main Status Page -->
        <main class="main">
            <!-- Logo & Title -->
            <h1 class="mb-4 title-flex">
                <!-- Logo -->
                <span class="logo-wrapper">
                    <button
                        v-if="editMode"
                        type="button"
                        class="logo-control"
                        :aria-label="$t('workspaceUploadLogo')"
                        @click="showImageCropUploadMethod"
                    >
                        <img :src="logoURL" alt="" width="56" height="56" class="logo" />
                        <font-awesome-icon icon="upload" class="icon-upload" aria-hidden="true" />
                    </button>
                    <img v-else :src="logoURL" alt="" width="56" height="56" class="logo" />
                </span>

                <Editable
                    v-model="config.title"
                    tag="span"
                    :contenteditable="editMode"
                    :noNL="true"
                    :aria-label="editMode ? $t('Title') : undefined"
                />
            </h1>
            <div v-if="editMode" class="mb-3">
                <button type="button" class="ws-button ws-button-quiet" @click="resetToDefaultImage">
                    {{ $t("workspaceResetLogo") }}
                </button>
            </div>

            <!-- Uploader -->
            <ImageCropUpload
                v-if="editMode && showImageCropUpload"
                v-model="showImageCropUpload"
                field="img"
                :width="128"
                :height="128"
                :langType="$i18n.locale"
                img-format="png"
                :noCircle="true"
                :noSquare="false"
                @crop-success="cropSuccess"
            />

            <!-- Admin functions -->
            <div v-if="hasToken && !loading" class="mb-2">
                <div v-if="!enableEditMode" class="ws-access-actions mb-3">
                    <button
                        type="button"
                        class="ws-button ws-button-primary"
                        :disabled="clickedEditButton"
                        data-testid="edit-button"
                        @click="edit"
                    >
                        <font-awesome-icon icon="edit" />
                        {{ $t("Edit Status Page") }}
                    </button>

                    <a href="/manage-status-page" class="ws-button ws-button-quiet">
                        <font-awesome-icon icon="tachometer-alt" />
                        {{ $t("Go to Dashboard") }}
                    </a>
                </div>
                <p v-if="clickedEditButton && !enableEditMode" class="form-text" role="status">
                    {{ $t("workspaceStatusOpeningEditor") }}
                </p>

                <div v-else>
                    <button
                        class="btn btn-primary btn-add-group me-2"
                        data-testid="create-incident-button"
                        @click="createIncident"
                    >
                        <font-awesome-icon icon="bullhorn" />
                        {{ $t("Create Incident") }}
                    </button>
                </div>
            </div>

            <!-- Incident Edit Form -->
            <IncidentEditForm
                v-if="
                    editIncidentMode &&
                    incident !== null &&
                    (!incident.id || !activeIncidents.some((i) => i.id === incident.id))
                "
                v-model="incident"
                @post="postIncident"
                @cancel="cancelIncident"
            />

            <!-- Active Pinned Incidents -->
            <template v-for="activeIncident in activeIncidents" :key="activeIncident.id">
                <!-- Edit mode for this specific incident -->
                <IncidentEditForm
                    v-if="editIncidentMode && incident !== null && incident.id === activeIncident.id"
                    v-model="incident"
                    @post="postIncident"
                    @cancel="cancelIncident"
                />

                <!-- Display mode for this incident -->
                <div
                    v-else
                    class="shadow-box alert mb-4 p-4 incident"
                    role="alert"
                    :class="'bg-' + activeIncident.style"
                    data-testid="incident"
                >
                    <h4 class="alert-heading" data-testid="incident-title">{{ activeIncident.title }}</h4>
                    <!-- eslint-disable vue/no-v-html -->
                    <div
                        class="content"
                        data-testid="incident-content"
                        v-html="getIncidentHTML(activeIncident.content)"
                    ></div>
                    <!-- eslint-enable vue/no-v-html -->

                    <!-- Incident Date -->
                    <div class="date mt-3">
                        {{
                            $t("dateCreatedAtFromNow", {
                                date: $root.datetime(activeIncident.createdDate),
                                fromNow: dateFromNow(activeIncident.createdDate),
                            })
                        }}
                        <br />
                        <span v-if="activeIncident.lastUpdatedDate">
                            {{
                                $t("lastUpdatedAtFromNow", {
                                    date: $root.datetime(activeIncident.lastUpdatedDate),
                                    fromNow: dateFromNow(activeIncident.lastUpdatedDate),
                                })
                            }}
                        </span>
                    </div>

                    <div v-if="editMode" class="mt-3">
                        <button class="btn btn-light me-2" @click="resolveIncident(activeIncident)">
                            <font-awesome-icon icon="check" />
                            {{ $t("Resolve") }}
                        </button>
                        <button class="btn btn-light me-2" @click="editIncident(activeIncident)">
                            <font-awesome-icon icon="edit" />
                            {{ $t("Edit") }}
                        </button>
                        <button
                            class="btn btn-light me-2"
                            @click="$refs.incidentManageModal.showDelete(activeIncident)"
                        >
                            <font-awesome-icon icon="unlink" />
                            {{ $t("Delete") }}
                        </button>
                    </div>
                </div>
            </template>

            <!-- Overall Status -->
            <div
                class="shadow-box overall-status mb-4"
                :class="{
                    'is-up': allUp,
                    'is-degraded': partialDown,
                    'is-down': allDown,
                    'is-maintenance': isMaintenance,
                }"
                role="status"
            >
                <div v-if="Object.keys($root.publicMonitorList).length === 0 && loadedData">
                    <font-awesome-icon icon="question-circle" aria-hidden="true" />
                    {{ $t("No Services") }}
                </div>

                <template v-else>
                    <div v-if="allUp">
                        <font-awesome-icon icon="check-circle" aria-hidden="true" />
                        {{ $t("All Systems Operational") }}
                    </div>

                    <div v-else-if="partialDown">
                        <font-awesome-icon icon="exclamation-circle" aria-hidden="true" />
                        {{ $t("Partially Degraded Service") }}
                    </div>

                    <div v-else-if="allDown">
                        <font-awesome-icon icon="times-circle" aria-hidden="true" />
                        {{ $t("Degraded Service") }}
                    </div>

                    <div v-else-if="isMaintenance">
                        <font-awesome-icon icon="wrench" aria-hidden="true" />
                        {{ $t("maintenanceStatus-under-maintenance") }}
                    </div>

                    <div v-else>
                        <font-awesome-icon icon="question-circle" aria-hidden="true" />
                        {{ $t("workspaceStateUnknown") }}
                    </div>
                </template>
            </div>

            <!-- Maintenance -->
            <template v-if="maintenanceList.length > 0">
                <div
                    v-for="maintenance in maintenanceList"
                    :key="maintenance.id"
                    class="shadow-box alert mb-4 p-3 bg-maintenance mt-4 position-relative"
                    role="alert"
                >
                    <h4 class="alert-heading">{{ maintenance.title }}</h4>
                    <!-- eslint-disable-next-line vue/no-v-html-->
                    <div class="content" v-html="maintenanceHTML(maintenance.description)"></div>
                    <MaintenanceTime :maintenance="maintenance" />
                </div>
            </template>

            <!-- Description -->
            <strong v-if="editMode">{{ $t("Description") }}:</strong>
            <Editable
                v-if="enableEditMode"
                v-model="config.description"
                :contenteditable="editMode"
                tag="div"
                class="mb-4 description"
                data-testid="description-editable"
            />
            <!-- eslint-disable vue/no-v-html-->
            <div
                v-if="!enableEditMode"
                class="alert-heading p-2"
                data-testid="description"
                v-html="descriptionHTML"
            ></div>
            <!-- eslint-enable vue/no-v-html-->

            <div v-if="editMode" class="mb-4">
                <div>
                    <button class="btn btn-primary btn-add-group me-2" data-testid="add-group-button" @click="addGroup">
                        <font-awesome-icon icon="plus" />
                        {{ $t("Add Group") }}
                    </button>
                </div>

                <div class="mt-3">
                    <div v-if="sortedMonitorList.length > 0 && loadedData">
                        <label>{{ $t("Add a monitor") }}:</label>
                        <VueMultiselect
                            v-model="selectedMonitor"
                            :options="sortedMonitorList"
                            :multiple="false"
                            :searchable="true"
                            :placeholder="$t('Add a monitor')"
                            label="name"
                            trackBy="name"
                            class="mt-3"
                            data-testid="monitor-select"
                        >
                            <template #option="{ option }">
                                <div class="d-inline-flex">
                                    <span>
                                        {{ option.pathName }}
                                        <Tag v-for="tag in option.tags" :key="tag" :item="tag" :size="'sm'" />
                                    </span>
                                </div>
                            </template>
                        </VueMultiselect>
                    </div>
                    <div v-else class="text-center">
                        {{ $t("No monitors available.") }}
                        <router-link to="/add">{{ $t("Add one") }}</router-link>
                    </div>
                </div>
            </div>

            <div class="mb-4">
                <div v-if="$root.publicGroupList.length === 0 && loadedData" class="text-center">
                    <!-- 👀 Nothing here, please add a group or a monitor. -->
                    👀 {{ $t("statusPageNothing") }}
                </div>

                <PublicGroupList
                    :edit-mode="enableEditMode"
                    :show-tags="config.showTags"
                    :show-certificate-expiry="config.showCertificateExpiry"
                    :show-only-last-heartbeat="config.showOnlyLastHeartbeat"
                />
            </div>

            <!-- Past Incidents -->
            <div v-if="pastIncidentCount > 0" class="past-incidents-section mb-4">
                <h2 class="past-incidents-title mb-3">
                    {{ $t("Past Incidents") }}
                </h2>

                <div class="past-incidents-content">
                    <div
                        v-for="(dateGroup, dateKey) in groupedIncidentHistory"
                        :key="dateKey"
                        class="incident-date-group mb-4"
                    >
                        <h4 class="incident-date-header">{{ dateKey }}</h4>
                        <div class="shadow-box incident-list-box">
                            <IncidentHistory
                                :incidents="dateGroup"
                                :edit-mode="enableEditMode"
                                :loading="incidentHistoryLoading"
                                @edit-incident="$refs.incidentManageModal.showEdit($event)"
                                @delete-incident="$refs.incidentManageModal.showDelete($event)"
                                @resolve-incident="resolveIncident"
                            />
                        </div>
                    </div>

                    <div v-if="incidentHistoryHasMore" class="load-more-controls d-flex justify-content-center mt-3">
                        <button
                            class="btn btn-outline-secondary btn-sm"
                            :disabled="incidentHistoryLoading"
                            @click="loadMoreIncidentHistory"
                        >
                            <span
                                v-if="incidentHistoryLoading"
                                class="spinner-border spinner-border-sm me-1"
                                role="status"
                            ></span>
                            {{ $t("Load More") }}
                        </button>
                    </div>
                </div>
            </div>

            <!-- Incident Manage Modal -->
            <IncidentManageModal
                v-if="enableEditMode"
                ref="incidentManageModal"
                :slug="slug"
                @incident-updated="loadIncidentHistory"
            />

            <footer class="mt-5 mb-4">
                <div class="custom-footer-text text-start">
                    <strong v-if="enableEditMode">{{ $t("Custom Footer") }}:</strong>
                </div>
                <Editable
                    v-if="enableEditMode"
                    v-model="config.footerText"
                    tag="div"
                    :contenteditable="enableEditMode"
                    :noNL="false"
                    class="alert-heading p-2"
                    data-testid="custom-footer-editable"
                />
                <!-- eslint-disable vue/no-v-html-->
                <div
                    v-if="!enableEditMode"
                    class="alert-heading p-2"
                    data-testid="footer-text"
                    v-html="footerHTML"
                ></div>
                <!-- eslint-enable vue/no-v-html-->

                <p v-if="config.showPoweredBy" data-testid="powered-by">
                    {{ $t("Powered by") }}
                    <a target="_blank" rel="noopener noreferrer" href="https://github.com/louislam/uptime-kuma">
                        {{ $t("Uptime Kuma") }}
                    </a>
                </p>

                <div v-if="lastUpdateTime" class="refresh-info mb-2">
                    <div>{{ $t("lastUpdatedAt", { date: lastUpdateTimeDisplay }) }}</div>
                    <div v-if="updateCountdownText" data-testid="update-countdown-text">
                        {{ $t("statusPageRefreshIn", [updateCountdownText]) }}
                    </div>
                </div>
            </footer>
        </main>

        <Confirm
            ref="confirmDelete"
            btn-style="btn-danger"
            :yes-text="$t('Yes')"
            :no-text="$t('No')"
            @yes="deleteStatusPage"
        >
            {{ $t("deleteStatusPageMsg") }}
        </Confirm>

        <component is="style" v-if="config.customCSS" type="text/css">
            {{ config.customCSS }}
        </component>
    </div>
    <main v-else class="workspace-shell ws-access" :class="{ dark: $root.isDark }">
        <div class="ws-access-panel">
            <h1 class="h4">{{ $t("Status Page") }}</h1>
            <template v-if="loadFailed">
                <p role="alert">{{ $t("workspaceStatusLoadFailed") }}</p>
                <button type="button" class="ws-button ws-button-primary" @click="reloadPage">{{ $t("Retry") }}</button>
            </template>
            <p v-else class="mb-0" role="status">{{ $t("Loading...") }}</p>
        </div>
    </main>
</template>

<script>
import axios from "axios";
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import Favico from "favico.js";
import ImageCropUpload from "vue-image-crop-upload";
import CodeEditor from "../components/CodeEditor.vue";
import NotFound from "./NotFound.vue";
import { useToast } from "../notifications";
import { marked } from "marked";
import DOMPurify from "dompurify";
import Confirm from "../components/Confirm.vue";
import PublicGroupList from "../components/PublicGroupList.vue";
import MaintenanceTime from "../components/MaintenanceTime.vue";
import IncidentHistory from "../components/IncidentHistory.vue";
import IncidentManageModal from "../components/IncidentManageModal.vue";
import IncidentEditForm from "../components/IncidentEditForm.vue";
import { getResBaseURL } from "../util-frontend";
import {
    STATUS_PAGE_ALL_DOWN,
    STATUS_PAGE_ALL_UP,
    STATUS_PAGE_MAINTENANCE,
    STATUS_PAGE_PARTIAL_DOWN,
    UP,
    MAINTENANCE,
} from "../util.ts";
import Tag from "../components/Tag.vue";
import VueMultiselect from "vue-multiselect";

const toast = useToast();
dayjs.extend(duration);

const leavePageMsg = "Do you really want to leave? you have unsaved changes!";

const favicon = new Favico({
    animation: "none",
});

export default {
    components: {
        NotFound,
        PublicGroupList,
        ImageCropUpload,
        Confirm,
        CodeEditor,
        MaintenanceTime,
        Tag,
        VueMultiselect,
        IncidentHistory,
        IncidentManageModal,
        IncidentEditForm,
    },

    // Leave Page for vue route change
    beforeRouteLeave(to, from, next) {
        next(!this.editMode || window.confirm(leavePageMsg));
    },

    props: {
        /** Override for the status page slug */
        overrideSlug: {
            type: String,
            required: false,
            default: null,
        },
    },

    data() {
        return {
            slug: null,
            enableEditMode: false,
            enableEditIncidentMode: false,
            hasToken: false,
            config: {
                analyticsType: null,
            },
            selectedMonitor: null,
            incident: null,
            previousIncident: null,
            showImageCropUpload: false,
            imgDataUrl: "/icon.svg",
            loadedTheme: false,
            notFound: false,
            loadFailed: false,
            loadedData: false,
            baseURL: "",
            clickedEditButton: false,
            publicConfigLoaded: false,
            privateConfigLoaded: false,
            privateConfigLoading: false,
            maintenanceList: [],
            lastUpdateTime: null,
            feedInterval: null,
            disposed: false,
            heartbeatsLoading: false,
            updateCountdown: null,
            updateCountdownText: null,
            loading: true,
            incidentHistory: [],
            incidentHistoryLoading: false,
            incidentHistoryNextCursor: null,
            incidentHistoryHasMore: false,
        };
    },
    computed: {
        logoURL() {
            if (this.imgDataUrl === "/icon.svg" || this.imgDataUrl.startsWith("data:")) {
                return this.imgDataUrl;
            } else {
                return this.baseURL + this.imgDataUrl;
            }
        },

        /**
         * If the monitor is added to public list, which will not be in this list.
         * @returns {object[]} List of monitors
         */
        sortedMonitorList() {
            let result = [];

            for (let id in this.$root.monitorList) {
                if (this.$root.monitorList[id] && !(id in this.$root.publicMonitorList)) {
                    let monitor = this.$root.monitorList[id];
                    result.push(monitor);
                }
            }

            result.sort((m1, m2) => {
                if (m1.active !== m2.active) {
                    if (m1.active === 0) {
                        return 1;
                    }

                    if (m2.active === 0) {
                        return -1;
                    }
                }

                if (m1.weight !== m2.weight) {
                    if (m1.weight > m2.weight) {
                        return -1;
                    }

                    if (m1.weight < m2.weight) {
                        return 1;
                    }
                }

                return m1.pathName.localeCompare(m2.pathName);
            });

            return result;
        },

        editMode() {
            return this.enableEditMode && this.$root.socket.connected;
        },

        editIncidentMode() {
            return this.enableEditIncidentMode;
        },

        isPublished() {
            return this.config.published;
        },

        maintenanceClass() {
            return "bg-maintenance";
        },

        overallStatus() {
            if (Object.keys(this.$root.publicLastHeartbeatList).length === 0) {
                return -1;
            }

            let status = STATUS_PAGE_ALL_UP;
            let hasUp = false;

            for (let id in this.$root.publicLastHeartbeatList) {
                let beat = this.$root.publicLastHeartbeatList[id];

                if (beat.status === MAINTENANCE) {
                    return STATUS_PAGE_MAINTENANCE;
                } else if (beat.status === UP) {
                    hasUp = true;
                } else {
                    status = STATUS_PAGE_PARTIAL_DOWN;
                }
            }

            if (!hasUp) {
                status = STATUS_PAGE_ALL_DOWN;
            }

            return status;
        },

        allUp() {
            return this.overallStatus === STATUS_PAGE_ALL_UP;
        },

        partialDown() {
            return this.overallStatus === STATUS_PAGE_PARTIAL_DOWN;
        },

        allDown() {
            return this.overallStatus === STATUS_PAGE_ALL_DOWN;
        },

        isMaintenance() {
            return this.overallStatus === STATUS_PAGE_MAINTENANCE;
        },

        incidentHTML() {
            if (this.incident && this.incident.content != null) {
                return DOMPurify.sanitize(marked(this.incident.content));
            } else {
                return "";
            }
        },

        descriptionHTML() {
            if (this.config.description != null) {
                return DOMPurify.sanitize(marked(this.config.description));
            } else {
                return "";
            }
        },

        footerHTML() {
            if (this.config.footerText != null) {
                return DOMPurify.sanitize(marked(this.config.footerText));
            } else {
                return "";
            }
        },

        lastUpdateTimeDisplay() {
            return this.$root.datetime(this.lastUpdateTime);
        },

        /**
         * Get all active pinned incidents for display at the top
         * @returns {object[]} List of active pinned incidents
         */
        activeIncidents() {
            return this.incidentHistory.filter((i) => i.active && i.pin);
        },

        /**
         * Count of past incidents (non-active or unpinned)
         * @returns {number} Number of past incidents
         */
        pastIncidentCount() {
            return this.incidentHistory.filter((i) => !(i.active && i.pin)).length;
        },

        /**
         * Group past incidents (non-active or unpinned) by date for display
         * Active+pinned incidents are shown separately at the top, not in this section
         * @returns {object} Incidents grouped by date string
         */
        groupedIncidentHistory() {
            const groups = {};
            const pastIncidents = this.incidentHistory.filter((i) => !(i.active && i.pin));
            for (const incident of pastIncidents) {
                const dateKey = this.formatDateKey(incident.createdDate);
                if (!groups[dateKey]) {
                    groups[dateKey] = [];
                }
                groups[dateKey].push(incident);
            }
            return groups;
        },
    },
    watch: {
        /**
         * If connected to the socket and logged in, request private data of this statusPage
         * @param {boolean} loggedIn Is the client logged in?
         * @returns {void}
         */
        "$root.loggedIn"(loggedIn) {
            if (loggedIn) {
                this.loadPrivateConfig();
            }
        },
        "$root.allowLoginDialog"(allowed) {
            if (allowed && !this.$root.loggedIn && this.clickedEditButton) {
                this.clickedEditButton = false;
                this.$root.toastError("workspaceStatusSignInAgain");
            }
        },

        /**
         * Selected a monitor and add to the list.
         * @param {object} monitor Monitor to add
         * @returns {void}
         */
        selectedMonitor(monitor) {
            if (monitor) {
                if (this.$root.publicGroupList.length === 0) {
                    this.addGroup();
                }

                const firstGroup = this.$root.publicGroupList[0];

                firstGroup.monitorList.push(monitor);
                this.selectedMonitor = null;
            }
        },

        // Set Theme
        "config.theme"() {
            this.$root.statusPageTheme = this.config.theme;
            this.loadedTheme = true;
        },

        "config.title"(title) {
            document.title = title;
        },

        "$root.monitorList"() {
            let count = Object.keys(this.$root.monitorList).length;

            // Since publicGroupList is getting from public rest api, monitors' tags may not present if showTags = false
            if (count > 0) {
                for (let group of this.$root.publicGroupList) {
                    for (let monitor of group.monitorList) {
                        if (monitor.tags === undefined && this.$root.monitorList[monitor.id]) {
                            monitor.tags = this.$root.monitorList[monitor.id].tags;
                        }
                    }
                }
            }
        },
    },
    async created() {
        this.hasToken = "token" in this.$root.storage();

        // Browser change page
        // https://stackoverflow.com/questions/7317273/warn-user-before-leaving-web-page-with-unsaved-changes
        window.addEventListener("beforeunload", this.warnBeforeUnload);

        // Special handle for dev
        this.baseURL = getResBaseURL();
    },
    async mounted() {
        this.slug = this.overrideSlug || this.$route.params.slug;

        if (!this.slug) {
            this.slug = "default";
        }

        this.getData()
            .then((res) => {
                if (this.disposed) {
                    return;
                }
                if (!this.privateConfigLoaded) {
                    this.config = res.data.config;
                }

                if (!this.config.domainNameList) {
                    this.config.domainNameList = [];
                }

                if (this.config.icon) {
                    this.imgDataUrl = this.config.icon;
                }

                this.maintenanceList = res.data.maintenanceList;
                this.$root.publicGroupList = res.data.publicGroupList;

                this.loading = false;

                this.feedInterval = setInterval(this.updateHeartbeatList, this.refreshSeconds() * 1000);

                this.updateUpdateTimer();
                this.publicConfigLoaded = true;
                this.finishEditLoading();
            })
            .catch((error) => {
                if (this.disposed) return;
                this.notFound = error.response?.status === 404;
                this.loadFailed = !this.notFound;
            });

        this.updateHeartbeatList();
        this.loadIncidentHistory();

        // Go to edit page if ?edit present
        // null means ?edit present, but no value
        if (this.$route.query.edit || this.$route.query.edit === null) {
            this.edit();
        }
    },
    beforeUnmount() {
        this.disposed = true;
        clearInterval(this.feedInterval);
        clearInterval(this.updateCountdown);
        window.removeEventListener("beforeunload", this.warnBeforeUnload);
    },
    methods: {
        /** @returns {void} Retry loading the public status page */
        reloadPage() {
            location.reload();
        },
        /**
         * @param {BeforeUnloadEvent} event Browser navigation.
         * @returns {void} Request confirmation when leaving the editor.
         */
        warnBeforeUnload(event) {
            if (this.editMode) {
                event.preventDefault();
                event.returnValue = leavePageMsg;
            }
        },

        /** @returns {number} Polling interval in seconds. */
        refreshSeconds() {
            const seconds = Number(this.config.autoRefreshInterval);
            return Number.isFinite(seconds) && seconds > 0 ? Math.max(5, seconds) : 300;
        },
        /**
         * Load authoritative editor settings once per page, without overwriting unsaved changes.
         * @returns {void}
         */
        loadPrivateConfig() {
            if (
                !this.clickedEditButton ||
                !this.$root.loggedIn ||
                this.privateConfigLoaded ||
                this.privateConfigLoading
            ) {
                return;
            }
            this.privateConfigLoading = true;
            this.$root
                .getSocket()
                .timeout(12000)
                .emit("getStatusPage", this.slug, (error, res) => {
                    if (this.disposed) return;
                    this.privateConfigLoading = false;
                    if (!error && res?.ok && this.$root.loggedIn) {
                        this.config = res.config;
                        if (!this.config.customCSS) {
                            this.config.customCSS = "body {\n  \n}\n";
                        }
                        this.privateConfigLoaded = true;
                        this.finishEditLoading();
                    } else {
                        this.clickedEditButton = false;
                        this.$root.toastError("workspaceStatusEditorFailed");
                    }
                });
        },

        /**
         * Enable inputs only after both initial responses have settled.
         * @returns {void}
         */
        finishEditLoading() {
            if (this.clickedEditButton && this.publicConfigLoaded && this.privateConfigLoaded) {
                this.enableEditMode = true;
                this.loadedData = true;
            }
        },

        /**
         * Get status page data
         * It should be preloaded in window.preloadData
         * @returns {Promise<any>} Status page data
         */
        getData: function () {
            if (window.preloadData) {
                return new Promise((resolve) =>
                    resolve({
                        data: window.preloadData,
                    })
                );
            } else {
                return axios.get("/api/status-page/" + this.slug);
            }
        },

        /**
         * Update the heartbeat list and update favicon if necessary
         * @returns {Promise<void>}
         */
        async updateHeartbeatList() {
            // If editMode, it will use the data from websocket.
            if (!this.editMode && !this.disposed && !this.heartbeatsLoading) {
                this.heartbeatsLoading = true;
                try {
                    const res = await axios.get("/api/status-page/heartbeat/" + this.slug, { timeout: 15000 });
                    if (this.disposed || this.editMode) {
                        return;
                    }
                    const { heartbeatList, uptimeList } = res.data;

                    this.$root.heartbeatList = heartbeatList;
                    this.$root.uptimeList = uptimeList;

                    const heartbeatIds = Object.keys(heartbeatList);
                    const downMonitors = heartbeatIds.reduce((downMonitorsAmount, currentId) => {
                        const monitorHeartbeats = heartbeatList[currentId];
                        const lastHeartbeat = monitorHeartbeats.at(-1);

                        if (lastHeartbeat) {
                            return lastHeartbeat.status === 0 ? downMonitorsAmount + 1 : downMonitorsAmount;
                        } else {
                            return downMonitorsAmount;
                        }
                    }, 0);

                    favicon.badge(downMonitors);

                    this.loadedData = true;
                    this.lastUpdateTime = dayjs();
                    this.updateUpdateTimer();
                } catch (error) {
                    if (!this.disposed) {
                        console.error("Could not refresh status page", error.message);
                    }
                } finally {
                    this.heartbeatsLoading = false;
                }
            }
        },

        /**
         * Setup timer to display countdown to refresh
         * @returns {void}
         */
        updateUpdateTimer() {
            clearInterval(this.updateCountdown);
            if (!this.lastUpdateTime) return;

            const refreshAt = this.lastUpdateTime.add(this.refreshSeconds(), "seconds");
            const tick = () => {
                const remaining = Math.max(0, Math.ceil(refreshAt.diff(dayjs()) / 1000));
                this.updateCountdownText = dayjs.duration(remaining, "seconds").format("mm:ss");
                if (!remaining) clearInterval(this.updateCountdown);
            };
            this.updateCountdown = setInterval(tick, 1000);
            tick();
        },

        /**
         * Enable editing mode
         * @returns {void}
         */
        edit() {
            if (this.hasToken) {
                if (this.$root.allowLoginDialog && !this.$root.loggedIn) {
                    this.$root.toastError("workspaceStatusSignInAgain");
                    return;
                }
                this.clickedEditButton = true;
                this.$root.initSocketIO(true);
                this.loadPrivateConfig();
                this.finishEditLoading();
            }
        },

        /**
         * Save the status page
         * @returns {void}
         */
        save() {
            if (this.loading || !this.editMode) return;
            this.loading = true;
            this.config.slug = this.config.slug.trim().toLowerCase();

            this.$root
                .getSocket()
                .emit("saveStatusPage", this.slug, this.config, this.imgDataUrl, this.$root.publicGroupList, (res) => {
                    if (res.ok) {
                        this.enableEditMode = false;
                        this.$root.publicGroupList = res.publicGroupList;
                        location.replace("/status/" + this.config.slug);
                    } else {
                        this.loading = false;
                        toast.error(res.msg);
                    }
                });
        },

        /**
         * Show dialog confirming deletion
         * @returns {void}
         */
        deleteDialog() {
            this.$refs.confirmDelete.show();
        },

        /**
         * Request deletion of this status page
         * @returns {void}
         */
        deleteStatusPage() {
            this.$root.getSocket().emit("deleteStatusPage", this.slug, (res) => {
                if (res.ok) {
                    this.enableEditMode = false;
                    location.href = "/manage-status-page";
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        /**
         * Returns label for a specified monitor
         * @param {object} monitor Object representing monitor
         * @returns {string} Monitor label
         */
        monitorSelectorLabel(monitor) {
            return `${monitor.name}`;
        },

        /**
         * Add a group to the status page
         * @returns {void}
         */
        addGroup() {
            let groupName = this.$t("Untitled Group");

            if (this.$root.publicGroupList.length === 0) {
                groupName = this.$t("Services");
            }

            this.$root.publicGroupList.unshift({
                name: groupName,
                monitorList: [],
            });
        },

        /**
         * Add a domain to the status page
         * @returns {void}
         */
        addDomainField() {
            this.config.domainNameList.push("");
        },

        /**
         * Discard changes to status page
         * @returns {void}
         */
        discard() {
            location.href = "/status/" + this.slug;
        },

        /**
         * Set URL of new image after successful crop operation
         * @param {string} imgDataUrl URL of image in data:// format
         * @returns {void}
         */
        cropSuccess(imgDataUrl) {
            this.imgDataUrl = imgDataUrl;
        },

        /**
         * Show image crop dialog if in edit mode
         * @returns {void}
         */
        showImageCropUploadMethod() {
            if (this.editMode) {
                this.showImageCropUpload = true;
            }
        },

        /**
         * Reset logo image to default (public/icon.svg)
         * @returns {void}
         */
        resetToDefaultImage() {
            if (!this.editMode) {
                return;
            }

            this.imgDataUrl = "/icon.svg";
            this.config.icon = this.imgDataUrl;
            toast.success(this.$t("imageResetConfirmation"));
        },

        /**
         * Create an incident for this status page
         * @returns {void}
         */
        createIncident() {
            this.enableEditIncidentMode = true;

            if (this.incident) {
                this.previousIncident = this.incident;
            }

            this.incident = {
                title: "",
                content: "",
                style: "primary",
            };
        },

        /**
         * Post the incident to the status page
         * @returns {void}
         */
        postIncident() {
            if (this.incident.title === "" || this.incident.content === "") {
                this.$root.toastError("Please input title and content");
                return;
            }

            this.$root.getSocket().emit("postIncident", this.slug, this.incident, (res) => {
                if (res.ok) {
                    this.enableEditIncidentMode = false;
                    this.incident = null;
                    this.loadIncidentHistory();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        /**
         * Edit an incident inline
         * @param {object} incident - The incident to edit
         * @returns {void}
         */
        editIncident(incident) {
            this.previousIncident = this.incident;
            this.incident = { ...incident };
            this.enableEditIncidentMode = true;
        },

        /**
         * Cancel creation or editing of incident
         * @returns {void}
         */
        cancelIncident() {
            this.enableEditIncidentMode = false;

            if (this.previousIncident) {
                this.incident = this.previousIncident;
                this.previousIncident = null;
            }
        },

        /**
         * Unpin the incident
         * @returns {void}
         */
        unpinIncident() {
            this.$root.getSocket().emit("unpinIncident", this.slug, () => {
                this.incident = null;
            });
        },

        /**
         * Get HTML for incident content
         * @param {string} content - Markdown content
         * @returns {string} Sanitized HTML
         */
        getIncidentHTML(content) {
            if (content != null) {
                return DOMPurify.sanitize(marked(content));
            }
            return "";
        },

        /**
         * Get the relative time difference of a date from now
         * @param {any} date Date to get time difference
         * @returns {string} Time difference
         */
        dateFromNow(date) {
            return dayjs.utc(date).fromNow();
        },

        /**
         * Remove a domain from the status page
         * @param {number} index Index of domain to remove
         * @returns {void}
         */
        removeDomain(index) {
            this.config.domainNameList.splice(index, 1);
        },

        /**
         * Generate sanitized HTML from maintenance description
         * @param {string} description Text to sanitize
         * @returns {string} Sanitized HTML
         */
        maintenanceHTML(description) {
            if (description) {
                return DOMPurify.sanitize(marked(description));
            } else {
                return "";
            }
        },

        /**
         * Load incident history for the status page
         * @returns {void}
         */
        loadIncidentHistory() {
            this.loadIncidentHistoryWithCursor(null);
        },

        /**
         * Load incident history using cursor-based pagination
         * @param {string|null} cursor - Cursor for pagination (created_date of last item)
         * @param {boolean} append - Whether to append to existing list
         * @returns {void}
         */
        loadIncidentHistoryWithCursor(cursor, append = false) {
            this.incidentHistoryLoading = true;

            if (this.enableEditMode) {
                this.$root.getSocket().emit("getIncidentHistory", this.slug, cursor, (res) => {
                    this.incidentHistoryLoading = false;
                    if (res.ok) {
                        if (append) {
                            this.incidentHistory = [...this.incidentHistory, ...res.incidents];
                        } else {
                            this.incidentHistory = res.incidents;
                        }
                        this.incidentHistoryNextCursor = res.nextCursor;
                        this.incidentHistoryHasMore = res.hasMore;
                    } else {
                        console.error("Failed to load incident history:", res.msg);
                        this.$root.toastError(res.msg);
                    }
                });
            } else {
                const url = cursor
                    ? `/api/status-page/${this.slug}/incident-history?cursor=${encodeURIComponent(cursor)}`
                    : `/api/status-page/${this.slug}/incident-history`;
                axios
                    .get(url)
                    .then((res) => {
                        this.incidentHistoryLoading = false;
                        if (res.data.ok) {
                            if (append) {
                                this.incidentHistory = [...this.incidentHistory, ...res.data.incidents];
                            } else {
                                this.incidentHistory = res.data.incidents;
                            }
                            this.incidentHistoryNextCursor = res.data.nextCursor;
                            this.incidentHistoryHasMore = res.data.hasMore;
                        }
                    })
                    .catch((error) => {
                        this.incidentHistoryLoading = false;
                        console.error("Failed to load incident history:", error);
                    });
            }
        },

        /**
         * Load more incident history using cursor-based pagination
         * @returns {void}
         */
        loadMoreIncidentHistory() {
            if (this.incidentHistoryHasMore && this.incidentHistoryNextCursor) {
                this.loadIncidentHistoryWithCursor(this.incidentHistoryNextCursor, true);
            }
        },

        /**
         * Format date key for grouping (e.g., "December 8, 2025")
         * @param {string} dateStr - ISO date string
         * @returns {string} Formatted date key
         */
        formatDateKey(dateStr) {
            if (!dateStr) {
                return this.$t("Unknown");
            }
            const date = new Date(dateStr);
            return date.toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
            });
        },

        /**
         * Resolve an incident
         * @param {object} incident - The incident to resolve
         * @returns {void}
         */
        resolveIncident(incident) {
            this.$root.getSocket().emit("resolveIncident", this.slug, incident.id, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadIncidentHistory();
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.status-workspace {
    display: grid;
    align-items: start;
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
    padding: clamp(16px, 4vw, 44px);
}

.main {
    width: min(100%, 990px);
    min-width: 0;
    margin-inline: auto;
    overflow-wrap: anywhere;
}

.title-flex {
    display: flex;
    align-items: center;
    gap: clamp(10px, 2vw, 18px);
    min-height: 56px;
    color: var(--ws-ink);
    font-size: clamp(24px, 4vw, 38px);
    font-weight: 730;
    letter-spacing: -0.025em;
}

.overall-status {
    --status-tone: var(--ws-muted);

    padding: clamp(16px, 3vw, 26px);
    border: 1px solid var(--ws-border);
    border-inline-start: 4px solid var(--status-tone);
    font-size: clamp(18px, 3vw, 24px);
    font-weight: 680;

    > div {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    svg {
        flex: 0 0 auto;
        color: var(--status-tone);
    }

    &.is-up {
        --status-tone: var(--ws-action);
    }

    &.is-degraded {
        --status-tone: var(--ws-warning);
    }

    &.is-down {
        --status-tone: var(--ws-danger);
    }

    &.is-maintenance {
        --status-tone: var(--trace-maintenance);
    }
}

.sidebar {
    min-width: 0;
    border: 1px solid var(--ws-border);
    border-radius: 14px;
    background: var(--ws-surface);
    box-shadow: var(--ws-shadow);
}

.sidebar-title {
    margin: 0;
    padding: 14px 16px;
    border-bottom: 1px solid var(--ws-border);
    font-size: 18px;
    font-weight: 700;
}

.sidebar-body {
    min-height: 0;
    padding-inline: 16px;
}

.sidebar-footer {
    position: sticky;
    z-index: 2;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--ws-border);
    border-radius: 0 0 14px 14px;
    background: var(--ws-surface);
}

.danger-zone {
    padding-block: 14px;
    border-top: 1px solid var(--ws-border);
}

@media (min-width: 960px) {
    .status-workspace.is-editing {
        grid-template-columns: minmax(250px, 320px) minmax(0, 1fr);
    }

    .sidebar {
        position: sticky;
        top: 16px;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        max-height: calc(100dvh - 32px);
    }

    .sidebar-body {
        overflow: auto;
    }
}

footer {
    text-align: center;
    font-size: 14px;
}

.logo-wrapper {
    display: inline-flex;
    flex: 0 0 auto;
}

.logo {
    display: block;
    object-fit: contain;
    border-radius: 10px;
}

.logo-control {
    position: relative;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: var(--ws-surface);
}

.icon-upload {
    position: absolute;
    inset: auto 2px 2px auto;
    padding: 4px;
    border-radius: 6px;
    background: var(--ws-action-soft);
    color: var(--ws-action);
    font-size: 19px;
}

.incident {
    .content {
        &[contenteditable="true"] {
            min-height: 60px;
        }
    }

    .date {
        font-size: 12px;
    }
}

.status-workspace .shadow-box:not(.alert) {
    background: var(--ws-surface);
    box-shadow: var(--ws-shadow);
}

.domain-name-list {
    li {
        display: flex;
        align-items: center;
        padding: 10px 0 10px 10px;

        .domain-input {
            flex-grow: 1;
            min-width: 0;
            background-color: transparent;
            border: none;
            color: var(--ws-ink);
        }
    }
}

.bg-maintenance {
    .alert-heading {
        font-weight: bold;
    }
}

.refresh-info {
    color: var(--ws-muted);
    font-variant-numeric: tabular-nums;
}

.past-incidents-title {
    font-size: 26px;
    font-weight: normal;
}

.past-incidents-section {
    .past-incidents-content {
        padding: 0;
    }
}

.incident-date-group {
    .incident-date-header {
        font-size: 1rem;
        font-weight: normal;
        color: var(--bs-secondary);
        margin-bottom: 0.75rem;
    }

    .incident-list-box {
        padding: 0;
    }
}
</style>
