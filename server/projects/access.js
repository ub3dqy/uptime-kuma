const { R } = require("redbean-node");
const TranslatableError = require("../translatable-error");
const levels = Object.freeze(Object.assign(Object.create(null), { viewer: 1, operator: 2, admin: 3 }));

/**
 * @param {string} key Safe translation key
 * @returns {Error} Public error
 */
function problem(key = "projectAccessDenied") {
    return new TranslatableError(key);
}
/**
 * @param {unknown} value Untrusted ID
 * @returns {number} Valid ID
 * @throws {Error} Invalid value or unavailable protected data
 */
function id(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw problem("projectInvalid");
    }
    return value;
}
/**
 * @param {unknown} value Untrusted text
 * @param {number} max Length
 * @returns {string} Text
 * @throws {Error} Invalid value or unavailable protected data
 */
function text(value, max = 120) {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
        throw problem("projectInvalid");
    }
    return value.trim();
}
/**
 * @param {unknown} value IANA zone
 * @returns {string} Valid zone
 * @throws {Error} Invalid value or unavailable protected data
 */
function zone(value) {
    const result = text(value, 64);
    try {
        new Intl.DateTimeFormat("en", { timeZone: result }).format();
    } catch {
        throw problem("projectInvalid");
    }
    return result;
}
/**
 * Check current human identity and membership on the owning database connection.
 * @param {number} userID Human user
 * @param {number} projectID Project
 * @param {string} minimum Required role
 * @param {object} db Connection/transaction
 * @returns {Promise<object>} Owned scope
 */
async function permit(userID, projectID, minimum = "viewer", db = R.knex) {
    id(userID);
    id(projectID);
    const transactional = db.isTransaction === true;
    const projectQuery = db("project").where({ id: projectID });
    if (transactional) {
        projectQuery.forUpdate();
    }
    const project = await projectQuery.first();
    // Lock the project before current permission reads. MySQL repeatable-read
    // snapshots must not reuse a role that another administrator just revoked.
    const userQuery = db("user").where({ id: userID, service_account: 0 });
    if (transactional) {
        userQuery.forShare();
    }
    const user = await userQuery.first();
    let active = Boolean(user?.active);
    if (user?.project_only) {
        const identityQuery = db("project_identity").where({ user_id: userID, active: 1 });
        if (transactional) {
            identityQuery.forShare();
        }
        active = Boolean(await identityQuery.first());
    }
    let member;
    if (active) {
        const memberQuery = db("project_member").where({ user_id: userID, project_id: projectID });
        if (transactional) {
            memberQuery.forShare();
        }
        member = await memberQuery.first();
    }
    if (!project || !member || !(levels[member.role] >= levels[minimum])) {
        throw problem();
    }
    return { ...project, role: member.role, actor_id: userID, installation_admin: !user.project_only };
}
/**
 * @param {object} db Connection
 * @param {object} scope Project scope
 * @param {string} action Fixed action
 * @param {number|string|null} target Target ID
 * @returns {Promise<void>} Audit write
 */
async function audit(db, scope, action, target = null) {
    await db("project_audit").insert({
        project_id: scope.id,
        user_id: scope.actor_id,
        action,
        target: target == null ? null : String(target).slice(0, 80),
        created_at: Date.now(),
    });
}

const publicEvents = new Set([
    "login",
    "loginByToken",
    "logout",
    "needSetup",
    "setup",
    "projectInviteInfo",
    "projectAcceptInvite",
]);
const accountEvents = new Set(["changePassword", "prepare2FA", "save2FA", "disable2FA", "verifyToken", "twoFAStatus"]);

/**
 * New participants never inherit the legacy installation-administrator API.
 * Project methods perform their own current membership and object checks.
 * @param {Socket} socket Connection
 * @returns {void}
 */
function installProjectGate(socket) {
    socket.use(async (packet, next) => {
        const [event, ...args] = packet;
        if (publicEvents.has(event) || String(event).startsWith("project")) {
            next();
            return;
        }
        try {
            if (socket.userID) {
                const user = await R.knex("user").where({ id: socket.userID, service_account: 0 }).first();
                if (!user || (!user.project_only && !user.active) || (user.project_only && !accountEvents.has(event))) {
                    throw problem();
                }
                if (
                    user.project_only &&
                    !(await R.knex("project_identity").where({ user_id: user.id, active: 1 }).first())
                ) {
                    throw problem();
                }
            }
            const actorID = socket.userID;
            const generation = socket.projectGeneration;
            const callback = packet.at(-1);
            if (typeof callback === "function") {
                packet[packet.length - 1] = (...reply) => {
                    if (socket.userID === actorID && socket.projectGeneration === generation && !socket.disconnected) {
                        callback(...reply);
                    } else {
                        callback({ ok: false, msg: "projectAccessDenied", msgi18n: true });
                    }
                };
            }
            next();
        } catch {
            const callback = args.at(-1);
            if (typeof callback === "function") {
                callback({ ok: false, msg: "projectAccessDenied", msgi18n: true });
            }
        }
    });
}

module.exports = { levels, problem, id, text, zone, permit, audit, installProjectGate };
