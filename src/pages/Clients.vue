<template>
    <div class="clients-page">
        <h1>{{ $t("clientGroupsTitle") }}</h1>
        <p>{{ $t("clientGroupsHelp") }}</p>
        <p v-if="error" class="text-danger" role="alert">{{ error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <div class="d-flex flex-wrap gap-2 mb-3">
            <button class="btn btn-primary" :disabled="loading || !ready" @click="edit(null)">
                {{ $t("clientGroupNew") }}
            </button>
            <button class="btn btn-normal" :disabled="loading || !ready" @click="loadClients()">
                {{ $t("Refresh") }}
            </button>
        </div>
        <div class="shadow-box mb-3">
            <p v-if="clients.length === 0 && !loading">{{ $t("clientGroupsEmpty") }}</p>
            <ul class="list-unstyled mb-0">
                <li v-for="client in clients" :key="client.id" class="mb-2">
                    <button
                        class="btn btn-normal text-start client-name"
                        :aria-pressed="client.id === selectedID"
                        :disabled="loading"
                        @click="edit(client)"
                    >
                        {{ client.name }}
                        <span class="text-secondary">({{ client.monitorIDs.length }})</span>
                    </button>
                </li>
            </ul>
        </div>
        <form class="shadow-box mb-3" @submit.prevent="save">
            <h2 class="h5">{{ $t(selectedID ? "clientGroupEdit" : "clientGroupNew") }}</h2>
            <label for="client-name" class="form-label">{{ $t("clientGroupName") }}</label>
            <input
                id="client-name"
                v-model="name"
                class="form-control mb-3"
                required
                maxlength="120"
                :disabled="loading || !ready"
            />
            <label for="client-monitor-search" class="form-label">{{ $t("clientGroupSelectMonitors") }}</label>
            <input
                id="client-monitor-search"
                v-model="search"
                class="form-control mb-2"
                type="search"
                :placeholder="$t('Search...')"
            />
            <p class="small text-secondary">{{ $t("clientGroupMembershipHelp", { count: monitorIDs.length }) }}</p>
            <fieldset class="monitor-picker mb-3" :disabled="loading || !ready">
                <legend class="visually-hidden">{{ $t("clientGroupSelectMonitors") }}</legend>
                <p v-if="filteredMonitors.length === 0">{{ $t("clientGroupNoMatches") }}</p>
                <div v-for="monitor in filteredMonitors" :key="monitor.id" class="form-check">
                    <input
                        :id="'client-monitor-' + monitor.id"
                        v-model="monitorIDs"
                        class="form-check-input"
                        type="checkbox"
                        :value="monitor.id"
                        :disabled="monitorIDs.length >= 100 && !monitorIDs.includes(monitor.id)"
                    />
                    <label :for="'client-monitor-' + monitor.id" class="form-check-label client-name">
                        {{ monitor.name }}
                    </label>
                </div>
            </fieldset>
            <div class="d-flex flex-wrap gap-2">
                <button class="btn btn-primary" type="submit" :disabled="loading || !ready">{{ $t("Save") }}</button>
                <button
                    v-if="selectedID"
                    class="btn btn-danger"
                    type="button"
                    :disabled="loading || !ready"
                    @click="confirmDelete = true"
                >
                    {{ $t("clientGroupDelete") }}
                </button>
            </div>
            <div v-if="confirmDelete" class="mt-3" role="alert">
                <p>{{ $t("clientGroupDeleteHelp", { name: currentClient.name }) }}</p>
                <button class="btn btn-danger me-2" type="button" :disabled="loading || !ready" @click="remove">
                    {{ $t("clientGroupConfirmDelete") }}
                </button>
                <button class="btn btn-normal" type="button" @click="confirmDelete = false">{{ $t("Cancel") }}</button>
            </div>
        </form>
        <form v-if="selectedID" class="shadow-box" @submit.prevent="openReport">
            <h2 class="h5">{{ $t("clientReportTitle") }}</h2>
            <p v-if="dirty" class="small">{{ $t("clientGroupSaveBeforeReport") }}</p>
            <div class="row g-3">
                <div class="col-12 col-sm-6">
                    <label for="client-report-start" class="form-label">{{ $t("exportHistoryStartUTC") }}</label>
                    <input
                        id="client-report-start"
                        v-model="start"
                        class="form-control"
                        type="datetime-local"
                        required
                    />
                </div>
                <div class="col-12 col-sm-6">
                    <label for="client-report-end" class="form-label">{{ $t("exportHistoryEndUTC") }}</label>
                    <input id="client-report-end" v-model="end" class="form-control" type="datetime-local" required />
                </div>
            </div>
            <button class="btn btn-primary mt-3" :disabled="dirty || loading || !ready">
                {{ $t("clientReportOpen") }}
            </button>
        </form>
    </div>
</template>

<script>
export default {
    data() {
        return {
            clients: [],
            loaded: false,
            selectedID: null,
            name: "",
            monitorIDs: [],
            search: "",
            loading: false,
            error: "",
            notice: "",
            confirmDelete: false,
            epoch: 0,
            start: new Date(Date.now() - 86400000).toISOString().slice(0, 16),
            end: new Date().toISOString().slice(0, 16),
        };
    },
    computed: {
        ready() {
            return this.$root.loggedIn && this.$root.socket.connected;
        },
        currentClient() {
            return this.clients.find((client) => client.id === this.selectedID);
        },
        dirty() {
            return (
                !this.currentClient ||
                this.name.trim() !== this.currentClient.name ||
                JSON.stringify([...this.monitorIDs].sort((a, b) => a - b)) !==
                    JSON.stringify([...this.currentClient.monitorIDs].sort((a, b) => a - b))
            );
        },
        filteredMonitors() {
            return Object.values(this.$root.monitorList)
                .filter(
                    (monitor) =>
                        monitor.type !== "group" && String(monitor.name ?? "").toLowerCase().includes(this.search.toLowerCase())
                )
                .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
        },
    },
    watch: {
        ready: {
            immediate: true,
            handler(value) {
                if (value && !this.loaded) {
                    this.loadClients();
                }
                if (!value) {
                    this.epoch++;
                    this.loading = false;
                    if (!this.$root.loggedIn) {
                        this.loaded = false;
                        this.clients = [];
                        this.edit(null);
                    }
                }
            },
        },
    },
    beforeUnmount() {
        this.epoch++;
    },
    methods: {
        /**
         * @param {object|null} client Saved client, or a new group
         * @returns {void} Fresh editing state
         */
        edit(client) {
            this.selectedID = client?.id ?? null;
            this.name = client?.name ?? "";
            this.monitorIDs = [...(client?.monitorIDs ?? [])];
            this.search = "";
            this.confirmDelete = false;
        },
        /**
         * @param {string} event Private socket event
         * @param {object} request Bounded request
         * @returns {Promise<object|null>} Response or visible error
         */
        async call(event, request) {
            const epoch = ++this.epoch;
            this.loading = true;
            this.error = "";
            this.notice = "";
            try {
                const response = await this.$root.getSocket().timeout(30000).emitWithAck(event, request);
                if (epoch !== this.epoch || !this.ready) {
                    return null;
                }
                if (!response.ok) {
                    this.error = this.$t(response.msg);
                    return null;
                }
                return response;
            } catch {
                if (epoch === this.epoch) {
                    this.error = this.$t("clientGroupFailed");
                }
                return null;
            } finally {
                if (epoch === this.epoch) {
                    this.loading = false;
                }
            }
        },
        /**
         * @param {number|null} selected Client to select after reloading
         * @returns {Promise<void>} Refreshed groups
         */
        async loadClients(selected = this.selectedID) {
            const response = await this.call("listClientGroups", {});
            if (response) {
                this.loaded = true;
                this.clients = response.clients;
                this.edit(this.clients.find((client) => client.id === selected) ?? null);
            }
        },
        /** @returns {Promise<void>} Saved group and membership */
        async save() {
            const result = await this.call("saveClientGroup", {
                id: this.selectedID,
                revision: this.currentClient?.revision,
                name: this.name,
                monitorIDs: this.monitorIDs,
            });
            if (result) {
                await this.loadClients(result.client.id);
                if (!this.error) {
                    this.notice = this.$t("Saved.");
                }
            }
        },
        /** @returns {Promise<void>} Deleted grouping, with monitors preserved */
        async remove() {
            const result = await this.call("deleteClientGroup", {
                id: this.selectedID,
                revision: this.currentClient?.revision,
            });
            if (result) {
                await this.loadClients(null);
            }
        },
        /** @returns {void} Navigate to a clean printable report */
        openReport() {
            if (this.dirty || !this.ready) {
                return;
            }
            const start = new Date(this.start + ":00.000Z");
            const end = new Date(this.end + ":00.000Z");
            if (
                !Number.isFinite(start.getTime()) ||
                !Number.isFinite(end.getTime()) ||
                start >= end ||
                end - start > 31 * 86400000 ||
                end.getTime() > Date.now()
            ) {
                this.error = this.$t("exportHistoryInvalidRange");
                return;
            }
            this.$router.push({
                name: "ClientReport",
                params: { id: this.selectedID },
                query: { revision: this.currentClient.revision, start: start.toISOString(), end: end.toISOString() },
            });
        },
    },
};
</script>

<style scoped>
.client-name {
    overflow-wrap: anywhere;
}

.monitor-picker {
    max-height: 22rem;
    overflow-y: auto;
    padding-inline: 0.5rem;
}
</style>
