const { R } = require("redbean-node");
const { validateExportRequest, MAX_EXPORT_ROWS } = require("./heartbeat-export");
const { loadSummaryHistory } = require("./period-summary-history");
const { buildPeriodSummary } = require("./period-summary");

const MAX_CLIENT_GROUPS = 100;
const MAX_CLIENT_MONITORS = 100;

/**
 * @param {object} request Existing client reference
 * @returns {void} Validated identity and optimistic revision
 * @throws {Error} Invalid identity
 */
function validateClientReference(request) {
    if (
        !request ||
        !Number.isSafeInteger(request.id) ||
        request.id <= 0 ||
        !Number.isSafeInteger(request.revision) ||
        request.revision < 1 ||
        request.revision >= 2147483647
    ) {
        throw new Error("clientGroupInvalid");
    }
}

/**
 * @param {number} userID Authenticated owner
 * @returns {Promise<object[]>} Owner-scoped client groups, without monitor settings
 * @throws {Error} Oversized stored group list
 */
async function listClientGroups(userID) {
    const clients = await R.knex("client_group")
        .select("id", "name", "revision")
        .where({ user_id: userID })
        .orderBy("id")
        .limit(MAX_CLIENT_GROUPS + 1);
    const members = await R.knex("client_group_monitor AS member")
        .join("client_group AS client", "client.id", "member.client_group_id")
        .join("monitor", "monitor.id", "member.monitor_id")
        .where("client.user_id", userID)
        .where("monitor.user_id", userID)
        .whereNot("monitor.type", "group")
        .select("member.client_group_id", "member.monitor_id")
        .orderBy("member.monitor_id")
        .limit(MAX_CLIENT_GROUPS * MAX_CLIENT_MONITORS + 1);
    if (clients.length > MAX_CLIENT_GROUPS || members.length > MAX_CLIENT_GROUPS * MAX_CLIENT_MONITORS) {
        throw new Error("clientGroupLimit");
    }
    const result = clients.map((client) => ({
        ...client,
        monitorIDs: members.filter((member) => member.client_group_id === client.id).map((member) => member.monitor_id),
    }));
    if (result.some((client) => client.monitorIDs.length > MAX_CLIENT_MONITORS)) {
        throw new Error("clientGroupLimit");
    }
    return result;
}

/**
 * Atomically replace a bounded set of owned monitors; stale editors cannot win.
 * @param {number} userID Authenticated owner
 * @param {object} request Client fields, IDs and revision
 * @param {Function} guard Recheck the connection before committing
 * @returns {Promise<object>} Saved client identity
 * @throws {Error} Invalid, stale or unauthorized request
 */
async function saveClientGroup(userID, request, guard = () => {}) {
    if (
        !request ||
        typeof request.name !== "string" ||
        !request.name.trim() ||
        request.name.trim().length > 120 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(request.name) ||
        !Array.isArray(request.monitorIDs) ||
        request.monitorIDs.length > MAX_CLIENT_MONITORS ||
        new Set(request.monitorIDs).size !== request.monitorIDs.length ||
        request.monitorIDs.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
        throw new Error("clientGroupInvalid");
    }
    const creating = request.id === null || request.id === undefined;
    if (!creating) {
        validateClientReference(request);
    }
    return R.knex.transaction(async (db) => {
        const monitors = request.monitorIDs.length
            ? await db("monitor")
                  .select("id")
                  .where({ user_id: userID })
                  .whereNot("type", "group")
                  .whereIn("id", request.monitorIDs)
            : [];
        if (monitors.length !== request.monitorIDs.length) {
            throw new Error("clientGroupInvalid");
        }
        let id = request.id;
        if (creating) {
            const { count } = await db("client_group").where({ user_id: userID }).count("* AS count").first();
            if (Number(count) >= MAX_CLIENT_GROUPS) {
                throw new Error("clientGroupLimit");
            }
            [id] = await db("client_group").insert({ user_id: userID, name: request.name.trim(), revision: 1 });
        } else {
            const changed = await db("client_group")
                .where({ id, user_id: userID, revision: request.revision })
                .update({ name: request.name.trim(), revision: request.revision + 1 });
            if (!changed) {
                throw new Error("clientGroupChanged");
            }
            await db("client_group_monitor").where({ client_group_id: id }).delete();
        }
        if (request.monitorIDs.length) {
            await db("client_group_monitor").insert(
                request.monitorIDs.map((monitorID) => ({ client_group_id: id, monitor_id: monitorID }))
            );
        }
        guard();
        return { id, revision: creating ? 1 : request.revision + 1 };
    });
}

/**
 * Delete only the client's grouping, retaining monitors and all observation history.
 * @param {number} userID Authenticated owner
 * @param {object} request Client identity and revision
 * @param {Function} guard Recheck the connection before committing
 * @returns {Promise<void>} Completed deletion
 * @throws {Error} Stale or unauthorized request
 */
async function deleteClientGroup(userID, request, guard = () => {}) {
    validateClientReference(request);
    await R.knex.transaction(async (db) => {
        const deleted = await db("client_group")
            .where({ id: request.id, user_id: userID, revision: request.revision })
            .delete();
        if (!deleted) {
            throw new Error("clientGroupChanged");
        }
        guard();
    });
}

/**
 * Fetch a bounded membership snapshot without exposing monitor credentials.
 * @param {number} userID Authenticated owner
 * @param {number} id Client ID
 * @returns {Promise<object>} Client and its owned monitors
 * @throws {Error} Missing client or invalid stored membership
 */
async function clientSnapshot(userID, id) {
    const client = await R.knex("client_group").select("id", "name", "revision").where({ id, user_id: userID }).first();
    if (!client) {
        throw new Error("clientGroupNotFound");
    }
    const monitors = await R.knex("client_group_monitor AS member")
        .leftJoin("monitor", "monitor.id", "member.monitor_id")
        .where("member.client_group_id", id)
        .select("monitor.id", "monitor.name", "monitor.user_id", "monitor.type")
        .orderBy("monitor.id")
        .limit(MAX_CLIENT_MONITORS + 1);
    if (
        monitors.length > MAX_CLIENT_MONITORS ||
        monitors.some((monitor) => monitor.user_id !== userID || monitor.type === "group")
    ) {
        throw new Error("clientGroupInvalid");
    }
    return { client, monitors: monitors.map(({ id, name }) => ({ id, name })) };
}

/**
 * Sum monitor-time, never average availability percentages or per-monitor p95.
 * @param {object[]} monitors Per-monitor summaries
 * @returns {object} Totals over the explicitly selected set of monitors
 */
function totalClientTime(monitors) {
    const counts = { up: 0, down: 0, pending: 0, maintenance: 0, unknown: 0, total: 0 };
    const time = { ...counts };
    let legacyChecks = 0;
    for (const { summary } of monitors) {
        for (const state of Object.keys(time)) {
            time[state] += summary.time[state];
            counts[state] += summary.counts[state];
        }
        legacyChecks += summary.legacyChecks;
    }
    return {
        counts,
        time,
        legacyChecks,
        availability: time.up + time.down ? time.up / (time.up + time.down) : null,
        coverage: time.total ? (time.total - time.unknown) / time.total : null,
    };
}

/**
 * Build an owner-scoped client report with one shared 50,000-row history budget.
 * @param {number} userID Authenticated owner
 * @param {object} request Client identity and strict UTC dates
 * @returns {Promise<object>} Immutable report data, free of messages and settings
 * @throws {Error} Invalid range, stale membership or excessive history
 */
async function buildClientReport(userID, request) {
    validateClientReference(request);
    const now = Date.now();
    const range = validateExportRequest({ monitorID: request.id, start: request.start, end: request.end }, now);
    if (Date.parse(request.end) > now) {
        throw new Error("exportHistoryInvalidRange");
    }
    const before = await clientSnapshot(userID, request.id);
    if (before.client.revision !== request.revision) {
        throw new Error("clientGroupChanged");
    }
    let budget = MAX_EXPORT_ROWS;
    const monitors = [];
    for (const monitor of before.monitors) {
        const history = await loadSummaryHistory({ ...range, monitorID: monitor.id }, now, budget);
        budget -= history.count;
        monitors.push({ ...monitor, summary: buildPeriodSummary(history.rows, request.start, request.end) });
    }
    const after = await clientSnapshot(userID, request.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error("clientGroupChanged");
    }
    return {
        client: before.client,
        generatedAt: new Date(now).toISOString(),
        start: request.start,
        end: request.end,
        monitors,
        totals: totalClientTime(monitors),
    };
}

module.exports = {
    listClientGroups,
    saveClientGroup,
    deleteClientGroup,
    buildClientReport,
    MAX_CLIENT_GROUPS,
    MAX_CLIENT_MONITORS,
};
