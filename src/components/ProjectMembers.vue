<template>
    <section class="ws-project-panel" data-testid="project-members">
        <h2>{{ $t("projectMembers") }}</h2>
        <p class="ws-channel-note">{{ $t("projectRolesHelp") }}</p>
        <p v-if="people.some((person) => person.installationAdmin)" class="ws-channel-note">
            {{ $t("projectInstallationAdminHelp") }}
        </p>
        <p v-if="error" role="alert" class="ws-form-error">{{ $t(error) }}</p>
        <ul class="ws-project-member-list">
            <li v-for="person in people" :key="person.id">
                <span>
                    <strong>{{ person.username }}</strong>
                    <small v-if="person.installationAdmin" class="d-block">{{ $t("projectInstallationAdmin") }}</small>
                </span>
                <span v-if="project.personal && person.id === project.ownerID">{{ $t("projectRole_admin") }}</span>
                <template v-else>
                    <select
                        v-model="roles[person.id]"
                        class="form-select"
                        :aria-label="$t('projectMemberRole', { name: person.username })"
                    >
                        <option v-for="role in roleNames" :key="role" :value="role">
                            {{ $t(`projectRole_${role}`) }}
                        </option>
                    </select>
                    <button
                        class="ws-button ws-button-quiet"
                        :disabled="busy || roles[person.id] === person.role"
                        @click="change(person, roles[person.id])"
                    >
                        {{ $t("Save") }}
                    </button>
                    <button class="ws-button ws-button-quiet" :disabled="busy" @click="removing = person">
                        {{ $t("projectRemoveAccess") }}
                    </button>
                </template>
            </li>
        </ul>
        <div v-if="removing" class="ws-test-state" role="alert">
            <p>{{ $t("projectRemoveConfirm", { name: removing.username }) }}</p>
            <div class="ws-wizard-buttons">
                <button class="ws-button ws-button-quiet" @click="removing = null">{{ $t("Cancel") }}</button>
                <button class="ws-button ws-button-primary" :disabled="busy" @click="change(removing, null)">
                    {{ $t("projectRemoveAccess") }}
                </button>
            </div>
        </div>
        <form class="ws-project-invite" @submit.prevent="invite">
            <h3>{{ $t("projectInvitePerson") }}</h3>
            <label>
                {{ $t("projectInviteRole") }}
                <select v-model="inviteRole" class="form-select">
                    <option v-for="role in roleNames" :key="role" :value="role">{{ $t(`projectRole_${role}`) }}</option>
                </select>
            </label>
            <button class="ws-button ws-button-primary" :disabled="busy" type="submit">
                {{ $t("projectMakeInvite") }}
            </button>
        </form>
        <div v-if="inviteURL" class="ws-test-state" role="status">
            <p>{{ $t("projectInviteLinkHelp") }}</p>
            <input :value="inviteURL" class="form-control" readonly :aria-label="$t('projectInviteLink')" />
            <button class="ws-button ws-button-quiet mt-3" @click="copy">
                {{ $t(copied ? "projectCopied" : "Copy") }}
            </button>
        </div>
        <h3 v-if="invites.length">{{ $t("projectOpenInvites") }}</h3>
        <ul class="ws-project-member-list">
            <li v-for="invitation in invites" :key="invitation.id">
                <span>{{ $t(`projectRole_${invitation.role}`) }} · {{ formatTime(invitation.expires_at) }}</span>
                <button class="ws-button ws-button-quiet" :disabled="busy" @click="revoke(invitation.id)">
                    {{ $t("projectRevokeInvite") }}
                </button>
            </li>
        </ul>
    </section>
</template>
<script>
import { projectRequest } from "../project-workflow";
export default {
    props: { project: { type: Object, required: true } },
    emits: ["changed"],
    data() {
        return {
            people: [],
            invites: [],
            roles: {},
            roleNames: ["viewer", "operator", "admin"],
            inviteRole: "viewer",
            inviteURL: "",
            copied: false,
            busy: false,
            error: "",
            removing: null,
            generation: 0,
        };
    },
    mounted() {
        this.load();
    },
    beforeUnmount() {
        this.generation++;
        this.inviteURL = "";
    },
    methods: {
        /** @returns {Promise<void>} Current membership without secrets */
        async load() {
            const generation = this.generation;
            try {
                const result = await projectRequest(this.$root, "projectMembers", { projectID: this.project.id });
                if (generation !== this.generation) {
                    return;
                }
                this.people = result.members;
                this.invites = result.invites;
                this.roles = Object.fromEntries(result.members.map((person) => [person.id, person.role]));
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
            }
        },
        /**
         * @param {string} event Action
         * @param {object} data Parameters
         * @returns {Promise<object|null>} Completed action
         */
        async act(event, data) {
            const generation = this.generation;
            this.busy = true;
            this.error = "";
            try {
                const result = await projectRequest(this.$root, event, { projectID: this.project.id, ...data });
                if (generation !== this.generation) {
                    return null;
                }
                this.$emit("changed");
                await this.load();
                return result;
            } catch (error) {
                if (generation === this.generation) {
                    this.error = error.message;
                }
                return null;
            } finally {
                if (generation === this.generation) {
                    this.busy = false;
                }
            }
        },
        /**
         * @param {object} person Target
         * @param {string|null} role Requested role
         * @returns {Promise<void>} Updated
         */
        async change(person, role) {
            await this.act("projectChangeMember", { userID: person.id, role, revision: this.project.revision });
            this.removing = null;
        },
        /** @returns {Promise<void>} New one-use invitation, never sent automatically */
        async invite() {
            const result = await this.act("projectCreateInvite", { role: this.inviteRole });
            if (result) {
                this.inviteURL = `${location.origin}/join-project#${result.token}`;
                this.copied = false;
            }
        },
        /**
         * @param {number} invitationID Invitation
         * @returns {Promise<void>} Explicit revoke
         */
        async revoke(invitationID) {
            await this.act("projectRevokeInvite", { id: invitationID });
        },
        /** @returns {Promise<void>} Only report copying if it actually succeeded */
        async copy() {
            try {
                await navigator.clipboard.writeText(this.inviteURL);
                this.copied = true;
            } catch {
                this.error = "projectCopyManually";
            }
        },
        /**
         * @param {number} value UTC milliseconds
         * @returns {string} Local readable expiry
         */
        formatTime(value) {
            return new Intl.DateTimeFormat(this.$i18n.locale, {
                dateStyle: "short",
                timeStyle: "short",
                timeZone: this.project.timezone,
            }).format(new Date(Number(value)));
        },
    },
};
</script>
