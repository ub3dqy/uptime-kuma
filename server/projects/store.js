const { R } = require("redbean-node");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { id, text, zone, levels, problem, permit, audit } = require("./access");
const { incidentEvidence } = require("../../src/incident-state.ts");
const { workFromBeat, workMessage } = require("../../src/site-work.ts");
const { currentServiceState, issueExplanation, serviceHost } = require("../../src/overview-state.ts");
const { responseTimeLimit } = require("../response-time-policy");
const passwordHash = require("../password-hash");
const net = require("node:net");
const passwordDigest = (value) => createHash("sha256").update(value).digest("hex");

/**
 * @param {unknown} value Explicit internal targets
 * @returns {string[]} Unique exact IPv4 addresses
 * @throws {Error} Invalid target list
 */
function approvedAddresses(value = []) {
    if (
        !Array.isArray(value) ||
        value.length > 50 ||
        value.some((address) => typeof address !== "string" || net.isIP(address) !== 4)
    ) {
        throw problem("projectInvalid");
    }
    return [...new Set(value)];
}
/**
 * @param {number} userID Original owner
 * @returns {Promise<void>} Preserve the original personal workspace
 */
async function ensurePersonalProject(userID) {
    const user = await R.knex("user").where({ id: userID, project_only: 0, service_account: 0, active: 1 }).first();
    if (!user) {
        return;
    }
    await R.knex.transaction(async (tx) => {
        if (await tx("project").where({ data_user_id: userID }).first()) {
            return;
        }
        const [projectID] = await tx("project").insert({
            owner_id: userID,
            data_user_id: userID,
            name: user.username.slice(0, 120),
            personal: 1,
            allowed_ips_json: "[]",
            created_at: Date.now(),
        });
        await tx("project_member").insert({ project_id: projectID, user_id: userID, role: "admin" });
        await tx("project_ai").insert({ project_id: projectID, host_id: "urn:uuid:" + randomUUID() });
    });
    // Older personal-workspace channels predate project encryption. Protect guided
    // mail/Telegram settings before any channel list is sent to the browser.
    await R.knex.transaction(async (tx) => {
        const channels = await tx("notification").where({ user_id: userID }).select("id", "config");
        for (const channel of channels) {
            let config;
            try {
                config = JSON.parse(channel.config);
            } catch {
                continue;
            }
            if (config.managedDelivery === true && !config.projectEncryption) {
                const protectedConfig = await require("../notification-config").protectNotificationConfig(
                    config,
                    userID,
                    channel.config,
                    tx
                );
                await tx("notification")
                    .where({ id: channel.id, config: channel.config })
                    .update({ config: JSON.stringify(protectedConfig) });
            }
        }
    });
}

/**
 * @param {number} userID Human identity
 * @returns {Promise<object[]>} Accessible project names only
 */
async function listProjects(userID) {
    return R.knex("project as p")
        .join("project_member as m", "m.project_id", "p.id")
        .where("m.user_id", id(userID))
        .orderBy("p.id")
        .select("p.id", "p.name", "p.timezone", "p.personal", "p.revision", "m.role");
}

/**
 * @param {number} userID Actor
 * @param {object} request Name/zone
 * @param {Function} guard Live socket guard
 * @returns {Promise<number>} New project
 */
async function createProject(userID, request, guard) {
    const name = text(request?.name);
    const timezone = zone(request?.timezone || "UTC");
    return R.knex.transaction(async (tx) => {
        await guard(tx);
        const actor = await tx("user").where({ id: userID, service_account: 0 }).first();
        if (
            !actor ||
            (actor.project_only && !(await tx("project_member").where({ user_id: userID, role: "admin" }).first()))
        ) {
            throw problem();
        }
        const count = await tx("project").where({ owner_id: userID }).count({ n: "id" }).first();
        if (Number(count.n) >= 50) {
            throw problem("projectLimit");
        }
        const [dataUserID] = await tx("user").insert({
            username: "__project_" + randomUUID(),
            password: randomBytes(48).toString("hex"),
            active: 0,
            project_only: 1,
            service_account: 1,
            twofa_status: 0,
        });
        const allowed = approvedAddresses(request.allowedIPs);
        if (actor.project_only && allowed.length) {
            throw problem("projectInvalid");
        }
        const [projectID] = await tx("project").insert({
            owner_id: userID,
            data_user_id: dataUserID,
            name,
            timezone,
            allowed_ips_json: JSON.stringify([...new Set(allowed)]),
            created_at: Date.now(),
        });
        await tx("project_member").insert({ project_id: projectID, user_id: userID, role: "admin" });
        await tx("project_ai").insert({ project_id: projectID, host_id: "urn:uuid:" + randomUUID() });
        await audit(tx, { id: projectID, actor_id: userID }, "projectCreated");
        await guard(tx);
        return projectID;
    });
}

/**
 * @param {object} row Saved beat
 * @returns {object} No raw remote messages
 */
function safeBeat(row) {
    const reason = issueExplanation("down", row.msg);
    const messages = {
        workspaceIssue404: "HTTP 404",
        workspaceIssueAccess: "HTTP 403",
        workspaceIssueRate: "HTTP 429",
        workspaceIssueServer: "HTTP 503",
        workspaceIssueDNS: "ENOTFOUND",
        workspaceIssueTLS: "TLS",
        workspaceIssueTimeout: "ETIMEDOUT",
        workspaceIssueSlow: "RESPONSE_TIME_LIMIT:",
        workspaceIssueProjectTarget: "PROJECT_TARGET_BLOCKED",
    };
    return {
        time: row.time,
        status: row.status,
        ping: row.ping,
        check_interval: row.check_interval,
        check_session: row.check_session,
        msg: workFromBeat(row) ? workMessage(workFromBeat(row)) : messages[reason] || "",
    };
}

/**
 * @param {object} row Check
 * @param {Map<number,object>} parents Owned checks and groups
 * @returns {boolean} An inactive, missing or cyclic parent pauses the child
 */
function parentIsInactive(row, parents) {
    const visited = new Set();
    let parent = row.parent;
    while (parent && visited.size < 50) {
        if (visited.has(parent)) {
            return true;
        }
        visited.add(parent);
        const ancestor = parents.get(parent);
        if (!ancestor || !ancestor.active) {
            return true;
        }
        parent = ancestor.parent;
    }
    return Boolean(parent);
}

/**
 * @param {number} userID Actor
 * @param {number} projectID Project
 * @returns {Promise<object>} Bounded sanitized workspace
 */
async function projectSnapshot(userID, projectID) {
    const scope = await permit(userID, projectID);
    const found = await R.knex("monitor")
        .where({ user_id: scope.data_user_id })
        .whereNot("type", "group")
        .orderBy("id")
        .limit(201);
    const rows = found.slice(0, 200);
    const ancestors = await R.knex("monitor").where({ user_id: scope.data_user_id }).select("id", "active", "parent");
    const parentMap = new Map(ancestors.map((row) => [row.id, row]));
    // Limit each indexed range before combining it. Ranking an entire history
    // on every poll would become slower as years of observations accumulate.
    const ranges = rows.map((row) =>
        R.knex
            .select("*")
            .from(
                R.knex("heartbeat")
                    .where({ monitor_id: row.id })
                    .select("id", "monitor_id", "time", "status", "ping", "msg", "check_interval", "check_session")
                    .orderBy("time", "desc")
                    .orderBy("id", "desc")
                    .limit(30)
                    .as("project_recent")
            )
    );
    const recent = ranges.length ? await R.knex.unionAll(ranges) : [];
    const beatsByMonitor = new Map();
    for (const beat of recent) {
        if (!beatsByMonitor.has(beat.monitor_id)) {
            beatsByMonitor.set(beat.monitor_id, []);
        }
        beatsByMonitor.get(beat.monitor_id).push(beat);
    }
    const monitors = [];
    for (const row of rows) {
        const beats = (beatsByMonitor.get(row.id) || []).sort(
            (a, b) => String(a.time).localeCompare(String(b.time)) || a.id - b.id
        );
        const forceInactive = parentIsInactive(row, parentMap);
        const observations = beats.map(safeBeat);
        const monitor = {
            id: row.id,
            name: row.name,
            type: row.type,
            active: row.active,
            forceInactive,
            interval: row.interval,
            timeout: row.timeout,
            max_response_time: row.max_response_time,
            hostname: serviceHost(row),
            siteWork: await require("../site-work").signalForMonitor(row),
        };
        const evidence = incidentEvidence(monitor, observations);
        monitors.push({ ...monitor, state: evidence.state, explanation: evidence.explanation, observations });
    }
    const config = await R.knex("project_ai").where({ project_id: projectID }).first();
    await permit(userID, projectID);
    return {
        project: {
            id: scope.id,
            name: scope.name,
            timezone: scope.timezone,
            role: scope.role,
            revision: scope.revision,
            personal: Boolean(scope.personal),
            ownerID: scope.owner_id,
            allowedIPs:
                scope.installation_admin && scope.role === "admin" ? JSON.parse(scope.allowed_ips_json) : undefined,
        },
        monitors,
        truncated: found.length > 200,
        ai: { mode: config.mode, state: config.state, verifiedAt: config.verified_at, projectRevision: scope.revision },
    };
}

/**
 * @param {number} userID Actor
 * @param {object} request ID/name/zone/revision
 * @param {Function} guard Live guard
 * @returns {Promise<void>} Saved
 */
async function updateProject(userID, request, guard) {
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await permit(userID, id(request.projectID), "admin", tx);
        if (request.revision !== scope.revision) {
            throw problem("projectChanged");
        }
        const values = { name: text(request.name), timezone: zone(request.timezone), revision: scope.revision + 1 };
        if (request.allowedIPs !== undefined) {
            if (!scope.installation_admin) {
                throw problem();
            }
            values.allowed_ips_json = JSON.stringify(approvedAddresses(request.allowedIPs));
        }
        await tx("project").where({ id: scope.id, revision: request.revision }).update(values);
        await audit(tx, scope, "projectUpdated");
        await guard(tx);
    });
}

/**
 * @param {number} userID Actor
 * @param {number} projectID Project
 * @returns {Promise<object>} Members/invites, never passwords or invite tokens
 */
async function members(userID, projectID) {
    await permit(userID, projectID, "admin");
    const people = await R.knex("project_member as m")
        .join("user as u", "u.id", "m.user_id")
        .where("m.project_id", projectID)
        .select("u.id", "u.username", "m.role", "u.project_only");
    const invites = await R.knex("project_invite")
        .where({ project_id: projectID })
        .whereNull("used_at")
        .where("expires_at", ">", Date.now())
        .select("id", "role", "expires_at")
        .limit(50);
    await permit(userID, projectID, "admin");
    return {
        members: people.map(({ project_only: projectOnly, ...person }) => ({
            ...person,
            installationAdmin: !projectOnly,
        })),
        invites,
    };
}

/**
 * @param {number} userID Actor
 * @param {object} request Member/revision
 * @param {Function} guard Guard
 * @returns {Promise<void>} Updated membership
 */
async function changeMember(userID, request, guard) {
    if (request.role !== null && (typeof request.role !== "string" || !levels[request.role])) {
        throw problem("projectInvalid");
    }
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await permit(userID, id(request.projectID), "admin", tx);
        const targetID = id(request.userID);
        const target = await tx("project_member").where({ project_id: scope.id, user_id: targetID }).forShare().first();
        if (!target || scope.revision !== request.revision) {
            throw problem("projectChanged");
        }
        if (scope.personal && scope.data_user_id === targetID) {
            throw problem("projectPersonalOwner");
        }
        if (target.role === "admin" && request.role !== "admin") {
            const administrators = await tx("project_member")
                .where({ project_id: scope.id, role: "admin" })
                .select("user_id")
                .forShare();
            if (administrators.length <= 1) {
                throw problem("projectLastAdmin");
            }
        }
        const query = tx("project_member").where({ project_id: scope.id, user_id: targetID });
        if (request.role === null) {
            await query.delete();
        } else {
            await query.update({ role: request.role });
        }
        await tx("project").where({ id: scope.id }).increment("revision", 1);
        await audit(tx, scope, request.role === null ? "memberRemoved" : "memberRoleChanged", targetID);
        // The actor may deliberately demote themself: validate the captured login, not their old role.
        await guard(tx);
    });
}

/**
 * @param {number} userID Actor
 * @param {object} request Project/role
 * @param {Function} guard Guard
 * @returns {Promise<object>} One-time invitation
 */
async function invite(userID, request, guard) {
    if (typeof request.role !== "string" || !levels[request.role]) {
        throw problem("projectInvalid");
    }
    const token = randomBytes(32).toString("base64url");
    return R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await permit(userID, id(request.projectID), "admin", tx);
        const count = await tx("project_invite")
            .where({ project_id: scope.id })
            .whereNull("used_at")
            .where("expires_at", ">", Date.now())
            .count({ n: "id" })
            .first();
        if (Number(count.n) >= 50) {
            throw problem("projectLimit");
        }
        const expires = Date.now() + 86400000;
        const [inviteID] = await tx("project_invite").insert({
            project_id: scope.id,
            created_by: userID,
            token_hash: passwordDigest(token),
            role: request.role,
            created_at: Date.now(),
            expires_at: expires,
        });
        await audit(tx, scope, "inviteCreated", inviteID);
        await guard(tx);
        return { token, expires_at: expires };
    });
}

/**
 * @param {string} token Invitation
 * @param {object} db Connection
 * @returns {Promise<object>} Valid invitation
 */
async function validInvite(token, db = R.knex) {
    if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token)) {
        throw problem("projectInviteInvalid");
    }
    const row = await db("project_invite")
        .where({ token_hash: passwordDigest(token) })
        .whereNull("used_at")
        .where("expires_at", ">", Date.now())
        .first();
    if (!row) {
        throw problem("projectInviteInvalid");
    }
    try {
        await permit(row.created_by, row.project_id, "admin", db);
    } catch {
        throw problem("projectInviteInvalid");
    }
    return row;
}

/**
 * @param {string} token Invitation
 * @returns {Promise<object>} Minimal public invitation label
 */
async function inviteInfo(token) {
    const row = await validInvite(token);
    const project = await R.knex("project").where({ id: row.project_id }).first();
    return { name: project.name, role: row.role, expires_at: row.expires_at };
}

/**
 * @param {number|null} userID Optional signed-in account
 * @param {object} request Invitation and new credentials
 * @param {Function} guard Socket identity
 * @returns {Promise<object>} Joined
 */
async function acceptInvite(userID, request, guard) {
    await validInvite(request?.token);
    let username;
    let hashed;
    if (!userID) {
        username = text(request.username, 80);
        if (
            !/^[\p{L}\p{N}_.@-]+$/u.test(username) ||
            typeof request.password !== "string" ||
            request.password.length < 12 ||
            Buffer.byteLength(request.password) > 72
        ) {
            throw problem("projectPasswordInvalid");
        }
        hashed = await passwordHash.generate(request.password);
    }
    return R.knex.transaction(async (tx) => {
        await guard(tx);
        const row = await validInvite(request.token, tx);
        let accountID = userID;
        if (!accountID) {
            if (await tx("user").whereRaw("LOWER(TRIM(username)) = ?", [username.toLowerCase()]).first()) {
                throw problem("projectUsernameUsed");
            }
            [accountID] = await tx("user").insert({
                username,
                password: randomBytes(48).toString("hex"),
                active: 0,
                project_only: 1,
                service_account: 0,
                twofa_status: 0,
            });
            await tx("project_identity").insert({ user_id: accountID, password: hashed, active: 1 });
        } else {
            const account = await tx("user").where({ id: accountID, service_account: 0 }).first();
            const active =
                account &&
                (account.project_only
                    ? await tx("project_identity").where({ user_id: accountID, active: 1 }).first()
                    : account.active);
            if (!active) {
                throw problem();
            }
        }
        const existing = await tx("project_member").where({ project_id: row.project_id, user_id: accountID }).first();
        if (!existing) {
            await tx("project_member").insert({ project_id: row.project_id, user_id: accountID, role: row.role });
        }
        const claimed = await tx("project_invite")
            .where({ id: row.id })
            .whereNull("used_at")
            .where("expires_at", ">", Date.now())
            .update({ used_at: Date.now() });
        if (!claimed) {
            throw problem("projectInviteInvalid");
        }
        await tx("project").where({ id: row.project_id }).increment("revision", 1);
        await audit(tx, { id: row.project_id, actor_id: accountID }, "inviteAccepted", accountID);
        await guard(tx);
        return { projectID: row.project_id, username };
    });
}

/**
 * @param {number} userID Actor
 * @param {object} request Invitation ID
 * @param {Function} guard Guard
 * @returns {Promise<void>} Revoked
 */
async function revokeInvite(userID, request, guard) {
    await R.knex.transaction(async (tx) => {
        const scope = await permit(userID, id(request.projectID), "admin", tx);
        await tx("project_invite")
            .where({ id: id(request.id), project_id: scope.id })
            .whereNull("used_at")
            .update({ used_at: Date.now() });
        await audit(tx, scope, "inviteRevoked", request.id);
        await guard(tx);
    });
}

/**
 * @param {object} request Monitor form
 * @returns {object} Allowlisted monitoring fields
 * @throws {Error} Invalid value or unavailable protected data
 */
function monitorValues(request) {
    const type = request.type;
    if (!["http", "keyword", "json-query", "dns", "port", "push"].includes(type)) {
        throw problem("projectInvalid");
    }
    const interval = request.interval;
    if (!Number.isInteger(interval) || interval < 20 || interval > 86400) {
        throw problem("projectInvalid");
    }
    const maxretries = request.maxretries ?? 2;
    if (!Number.isInteger(maxretries) || maxretries < 0 || maxretries > 5) {
        throw problem("projectInvalid");
    }
    const values = {
        name: text(request.name),
        type,
        interval,
        retry_interval: Math.min(30, interval),
        maxretries,
        timeout: 15,
        max_response_time: responseTimeLimit(type, request.max_response_time),
        ignore_tls: 0,
        upside_down: 0,
        method: "GET",
        accepted_statuscodes_json: '["200-299"]',
        maxredirects: 3,
        expiry_notification: request.expiryNotification === true ? 1 : 0,
        domain_expiry_notification: 0,
        resend_interval: 0,
        kafka_producer_brokers: "[]",
        kafka_producer_sasl_options: "{}",
        rabbitmq_nodes: "[]",
        conditions: "[]",
    };
    if (["http", "keyword", "json-query"].includes(type)) {
        const target = text(request.url, 2048);
        let url;
        try {
            url = new URL(target);
        } catch {
            throw problem("projectInvalid");
        }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
            throw problem("projectInvalid");
        }
        values.url = url.href;
        if (type === "keyword") {
            values.keyword = text(request.keyword, 500);
        }
        if (type === "json-query") {
            values.json_path = text(request.jsonPath, 500);
            if (
                !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[(?:0|[1-9]\d{0,5})\]){0,30}$/.test(
                    values.json_path
                )
            ) {
                throw problem("projectInvalid");
            }
            values.expected_value = text(request.expectedValue, 500);
            values.json_path_operator = "==";
        }
    }
    if (["dns", "port"].includes(type)) {
        values.hostname = text(request.hostname, 253);
        if (!/^[a-z\d.:[\]_-]+$/i.test(values.hostname)) {
            throw problem("projectInvalid");
        }
        values.port = request.port ?? (type === "dns" ? 53 : 443);
        if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) {
            throw problem("projectInvalid");
        }
        if (type === "dns") {
            values.dns_resolve_type = "A";
            values.dns_resolve_server = text(request.dnsServer || "1.1.1.1", 253);
            if (net.isIP(values.dns_resolve_server) !== 4) {
                throw problem("projectInvalid");
            }
        }
    }
    return values;
}

/**
 * @param {number} userID Actor
 * @param {object} request Project/check
 * @param {Function} guard Guard
 * @returns {Promise<number>} Saved check
 */
async function saveMonitor(userID, request, guard) {
    const values = monitorValues(request);
    return R.knex.transaction(async (tx) => {
        const scope = await permit(userID, id(request.projectID), "operator", tx);
        const actor = await tx("user").where({ id: userID }).first();
        if (scope.personal && actor.project_only) {
            throw problem("projectUsePersonalEditor");
        }
        let monitorID = request.id == null ? null : id(request.id);
        if (monitorID) {
            const existing = await tx("monitor").where({ id: monitorID, user_id: scope.data_user_id }).first();
            if (!existing || request.revision !== scope.revision) {
                throw problem("projectChanged");
            }
            // Advanced legacy checks must be edited in their original owner interface.
            if (scope.personal) {
                throw problem("projectUsePersonalEditor");
            }
            await tx("monitor").where({ id: monitorID, user_id: scope.data_user_id }).update(values);
        } else {
            const count = await tx("monitor").where({ user_id: scope.data_user_id }).count({ n: "id" }).first();
            if (Number(count.n) >= 200) {
                throw problem("projectLimit");
            }
            [monitorID] = await tx("monitor").insert({
                ...values,
                user_id: scope.data_user_id,
                active: 1,
                push_token: values.type === "push" ? randomBytes(15).toString("base64url") : null,
            });
        }
        await audit(tx, scope, "monitorSaved", monitorID);
        await tx("project").where({ id: scope.id }).increment("revision", 1);
        await guard(tx);
        return monitorID;
    });
}

/**
 * @param {number} userID Actor
 * @param {object} request Project/check
 * @returns {Promise<object>} Explicit editor fields for operators
 */
async function monitorEditor(userID, request) {
    const scope = await permit(userID, id(request.projectID), "operator");
    const row = await R.knex("monitor")
        .where({ id: id(request.id), user_id: scope.data_user_id })
        .first();
    if (!row || scope.personal) {
        throw problem("projectUsePersonalEditor");
    }
    await permit(userID, request.projectID, "operator");
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        url: row.url,
        hostname: row.hostname,
        port: row.port,
        dnsServer: row.dns_resolve_server,
        interval: row.interval,
        maxretries: row.maxretries,
        max_response_time: row.max_response_time,
        expiryNotification: Boolean(row.expiry_notification),
        keyword: row.keyword,
        jsonPath: row.json_path,
        expectedValue: row.expected_value,
        pushToken: row.type === "push" ? row.push_token : undefined,
        revision: scope.revision,
    };
}

/**
 * @param {number} userID Actor
 * @param {object} request Project/check/action
 * @param {Function} guard Guard
 * @returns {Promise<object>} Committed monitor action
 */
async function controlMonitor(userID, request, guard) {
    if (!["pause", "resume"].includes(request.action)) {
        throw problem("projectInvalid");
    }
    return R.knex.transaction(async (tx) => {
        const scope = await permit(userID, id(request.projectID), "operator", tx);
        const row = await tx("monitor")
            .where({ id: id(request.id), user_id: scope.data_user_id })
            .first();
        if (!row) {
            throw problem();
        }
        await tx("monitor")
            .where({ id: row.id, user_id: scope.data_user_id })
            .update({ active: request.action === "resume" ? 1 : 0 });
        await audit(tx, scope, request.action === "resume" ? "monitorResumed" : "monitorPaused", row.id);
        await guard(tx);
        return { id: row.id, ownerID: scope.data_user_id, active: request.action === "resume" };
    });
}

module.exports = {
    ensurePersonalProject,
    listProjects,
    createProject,
    projectSnapshot,
    updateProject,
    members,
    changeMember,
    invite,
    inviteInfo,
    acceptInvite,
    revokeInvite,
    saveMonitor,
    monitorEditor,
    controlMonitor,
    safeBeat,
    parentIsInactive,
    currentServiceState,
};
