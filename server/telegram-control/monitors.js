const { R } = require("redbean-node");
const { audit, levels, permit, problem } = require("../projects/access");
const { parentIsInactive } = require("../projects/store");
const { incidentEvidence } = require("../../src/incident-state.ts");
const { currentServiceState, issueExplanation, observationTime, serviceHost } = require("../../src/overview-state.ts");
const { validateExportRequest } = require("../heartbeat-export");
const { buildPeriodSummary } = require("../period-summary");
const { loadSummaryHistory } = require("../period-summary-history");
const { Settings } = require("../settings");
const { signalForMonitor } = require("../site-work");
const { projectAI } = require("./ai");

const pageSize = 8;
const durations = [15, 30, 60, 120];
const actions = {
    pause: "telegramMonitorPaused",
    resume: "telegramMonitorResumed",
    maintenance: "telegramMaintenanceStarted",
    end: "telegramMaintenanceEnded",
};

/**
 * @param {object} config Bound installation user and project
 * @param {object} services Runtime monitor and maintenance synchronization
 * @param {Function} verifyChannel Recheck a shared Telegram channel while the current project is authorized
 * @returns {object} Project-scoped operations for one provisioned Telegram account
 */
function projectMonitors(config, services, verifyChannel) {
    const { userId, projectId } = config;
    /**
     * @param {string} role Minimum project role
     * @param {object} db Current connection or transaction
     * @returns {Promise<object>} Current project access
     */
    async function authorize(role = "viewer", db = R.knex) {
        const scope = await permit(userId, projectId, role, db);
        const setting = db("setting").where({ key: "disableAuth" }).first("value");
        if (db.isTransaction) {
            setting.forShare();
        }
        const row = await setting;
        if (row?.value && JSON.parse(row.value)) {
            throw problem();
        }
        await verifyChannel?.(scope, db);
        return scope;
    }

    /**
     * @param {Function} read Scoped read
     * @returns {Promise<object>} Current project result
     */
    async function readProject(read) {
        const scope = await authorize();
        const result = await read(scope);
        if ((await authorize()).data_user_id !== scope.data_user_id) {
            throw problem();
        }
        return { ...result, timezone: scope.timezone };
    }

    /**
     * @param {object} db Current connection or transaction
     * @param {object} scope Authorized project
     * @returns {object} Query limited to owned monitors
     */
    function ownedMonitors(db, scope) {
        return db("monitor").where("monitor.user_id", scope.data_user_id);
    }

    /**
     * @param {object} db Current connection or transaction
     * @param {object} scope Authorized project
     * @param {number} monitorID Requested monitor
     * @returns {Promise<object>} Scoped, individual monitor
     */
    async function ownedMonitor(db, scope, monitorID) {
        const query = ownedMonitors(db, scope)
            .where("monitor.id", monitorID)
            .whereNot("monitor.type", "group")
            .first("id", "user_id", "name", "type", "active", "parent", "interval", "timeout", "url", "hostname");
        if (db.isTransaction) {
            query.forUpdate();
        }
        const monitor = await query;
        if (!monitor) {
            throw problem();
        }
        return monitor;
    }

    /**
     * @param {object} db Current connection or transaction
     * @param {object} scope Authorized project
     * @returns {Promise<Map>} Parent relationships for this project
     */
    async function parents(db, scope) {
        const rows = await ownedMonitors(db, scope).select("id", "active", "parent");
        return new Map(rows.map((row) => [row.id, row]));
    }

    /**
     * @param {object} db Current connection or transaction
     * @param {object} scope Authorized project
     * @param {number} now Captured time in milliseconds
     * @returns {object} Query for active windows started by this project's bot
     */
    function activeWindows(db, scope, now) {
        return db("maintenance as m")
            .join("monitor_maintenance as mm", "mm.maintenance_id", "m.id")
            .join("monitor as n", "n.id", "mm.monitor_id")
            .where({
                "m.user_id": scope.data_user_id,
                "n.user_id": scope.data_user_id,
                "m.active": 1,
                "m.strategy": "single",
                "m.timezone": "UTC",
            })
            .where("m.start_date", "<=", sqlTime(now))
            .where("m.end_date", ">", sqlTime(now))
            .whereExists(
                db("project_audit as a")
                    .where({ "a.project_id": scope.id, "a.action": actions.maintenance })
                    .whereRaw("?? = CONCAT(??, ':', ??)", ["a.target", "m.id", "n.id"])
            )
            .whereNotExists(
                db("monitor_maintenance as other")
                    .whereColumn("other.maintenance_id", "m.id")
                    .whereColumn("other.monitor_id", "!=", "n.id")
            )
            .whereNotExists(db("maintenance_status_page as published").whereColumn("published.maintenance_id", "m.id"))
            .select("m.id", "m.end_date as end", "n.id as monitorID", "n.name");
    }

    /**
     * @param {object} db Current connection or transaction
     * @param {object} scope Authorized project
     * @param {object} monitor Owned monitor and its parent
     * @param {Map} parentMap Owned parent relationships
     * @param {number} now Captured UTC time
     * @returns {Promise<boolean>} Whether an existing work window covers the monitor
     */
    async function underMaintenance(db, scope, monitor, parentMap, now) {
        const ids = [monitor.id];
        let parent = monitor.parent;
        while (parent && ids.length <= 50 && !ids.includes(parent)) {
            ids.push(parent);
            parent = parentMap.get(parent)?.parent;
        }
        const rows = await db("monitor_maintenance as mm")
            .join("maintenance as m", "mm.maintenance_id", "m.id")
            .whereIn("mm.monitor_id", ids)
            .where({ "m.user_id": scope.data_user_id, "m.active": 1 })
            .select("m.id", "m.strategy", "m.start_date", "m.end_date", "m.timezone");
        for (const row of rows) {
            if (row.strategy === "manual") {
                return true;
            }
            if (row.strategy === "single" && row.timezone === "UTC") {
                if (
                    (!row.start_date || observationTime(row.start_date) <= now) &&
                    (!row.end_date || observationTime(row.end_date) > now)
                ) {
                    return true;
                }
                continue;
            }
            if (await services.isUnderMaintenance(row.id)) {
                return true;
            }
        }
        return (await signalForMonitor(monitor, now))?.state === "active";
    }

    return {
        authorize,
        ai: projectAI(config, authorize, async (monitorID) =>
            panelURL(await Settings.get("primaryBaseURL"), `/projects/${projectId}`, {
                section: "ai",
                ...(monitorID === null ? {} : { check: monitorID }),
            })
        ),
        async list(filter = "all", page = 0, search = "") {
            return readProject(async (scope) => {
                const now = Date.now();
                const rows = await ownedMonitors(R.knex, scope)
                    .leftJoin(
                        "heartbeat as latest",
                        "latest.id",
                        R.knex.raw(
                            "(SELECT h.id FROM heartbeat h WHERE h.monitor_id = monitor.id AND h.time <= ? ORDER BY h.time DESC, h.id DESC LIMIT 1)",
                            [heartbeatTime(now)]
                        )
                    )
                    .orderBy("monitor.name")
                    .orderBy("monitor.id")
                    .select(
                        "monitor.id",
                        "monitor.type",
                        "monitor.name",
                        "monitor.active",
                        "monitor.parent",
                        "monitor.interval",
                        "monitor.timeout",
                        "latest.time",
                        "latest.status"
                    );
                const parentMap = new Map(rows.map((row) => [row.id, row]));
                const counts = { up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0 };
                const matches = [];
                const needle = search.toLowerCase();
                for (const monitor of rows) {
                    if (!monitor.type || monitor.type === "group") {
                        continue;
                    }
                    monitor.forceInactive = parentIsInactive(monitor, parentMap);
                    const { state } = currentServiceState(monitor, [monitor], now);
                    counts[state]++;
                    const name = String(monitor.name || "");
                    if (
                        name.toLowerCase().includes(needle) &&
                        (filter === "all" ||
                            filter === state ||
                            (filter === "issues" && ["down", "pending", "unknown"].includes(state)))
                    ) {
                        matches.push({ id: monitor.id, name, state });
                    }
                }
                const lastPage = Math.max(0, Math.ceil(matches.length / pageSize) - 1);
                const currentPage = Math.min(page, lastPage);
                return {
                    name: scope.name,
                    counts,
                    page: currentPage,
                    lastPage,
                    total: matches.length,
                    monitors: matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
                };
            });
        },
        async detail(monitorID) {
            return readProject(async (scope) => {
                const now = Date.now();
                const monitor = await ownedMonitor(R.knex, scope, monitorID);
                monitor.forceInactive = parentIsInactive(monitor, await parents(R.knex, scope));
                const history = await R.knex("heartbeat")
                    .where({ monitor_id: monitorID })
                    .where("time", "<=", heartbeatTime(now))
                    .orderBy("time", "desc")
                    .orderBy("id", "desc")
                    .limit(30)
                    .select("time", "status", "ping", "msg", "check_interval", "check_session");
                const evidence = incidentEvidence(monitor, history.reverse(), now);
                const window = await activeWindows(R.knex, scope, now)
                    .where("n.id", monitorID)
                    .orderBy("m.id", "desc")
                    .first();
                const base = await Settings.get("primaryBaseURL");
                return {
                    id: monitor.id,
                    name: monitor.name,
                    active: Boolean(monitor.active),
                    canControl: levels[scope.role] >= levels.operator,
                    parentPaused: monitor.forceInactive,
                    host: evidence.host,
                    state: evidence.state,
                    checkedAt: evidence.checkedAt,
                    ping: evidence.latest?.ping,
                    explanation: evidence.explanation,
                    lastError: evidence.lastBad && issueExplanation("down", evidence.lastBad.msg),
                    confirmedAt: evidence.firstConfirmed?.time,
                    limited: evidence.historyLimited,
                    lastGood: evidence.lastGood?.time,
                    recent: evidence.recent,
                    window,
                    url: panelURL(base, scope.personal ? `/dashboard/${monitor.id}` : `/projects/${projectId}`),
                };
            });
        },
        async report(monitorID) {
            return readProject(async (scope) => {
                const monitor = await ownedMonitor(R.knex, scope, monitorID);
                const now = Date.now();
                const start = new Date(now - 86400000).toISOString();
                const end = new Date(now).toISOString();
                const range = validateExportRequest({ monitorID, start, end }, now);
                const { rows } = await loadSummaryHistory(range, now);
                return { name: monitor.name, ...buildPeriodSummary(rows, start, end) };
            });
        },
        async certificates(page) {
            return readProject(async (scope) => {
                const rows = await ownedMonitors(R.knex, scope)
                    .join("monitor_tls_info as tls", "tls.monitor_id", "monitor.id")
                    .select("monitor.id", "monitor.name", "monitor.url", "monitor.hostname", "tls.info_json");
                const certificates = rows
                    .flatMap((row) => {
                        try {
                            const value = JSON.parse(row.info_json)?.certInfo?.validTo;
                            const end = typeof value === "string" ? Date.parse(value) : NaN;
                            return Number.isFinite(end)
                                ? [{ id: row.id, name: row.name, host: serviceHost(row), end }]
                                : [];
                        } catch {
                            return [];
                        }
                    })
                    .sort((first, second) => first.end - second.end);
                const lastPage = Math.max(0, Math.ceil(certificates.length / pageSize) - 1);
                const currentPage = Math.min(page, lastPage);
                return {
                    page: currentPage,
                    lastPage,
                    certificates: certificates.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
                };
            });
        },
        async deliveries() {
            return readProject(async (scope) => ({
                rows: await R.knex("notification_delivery as d")
                    .join("notification as n", function () {
                        this.on("d.notification_id", "n.id").andOn("d.user_id", "n.user_id");
                    })
                    .where("d.user_id", scope.data_user_id)
                    .select("n.name", "d.status", "d.confirmed_at", "d.updated_at")
                    .orderBy("d.id", "desc")
                    .limit(pageSize),
            }));
        },
        async windows() {
            return readProject(async (scope) => ({
                rows: await activeWindows(R.knex, scope, Date.now()).orderBy("m.end_date").limit(pageSize),
            }));
        },
        async journal() {
            return readProject(async (scope) => ({
                rows: await R.knex("project_audit")
                    .where({ project_id: scope.id, user_id: userId })
                    .whereIn("action", Object.values(actions))
                    .select("action", "target", "created_at")
                    .orderBy("id", "desc")
                    .limit(pageSize),
            }));
        },
        async prepare(action, monitorID, argument) {
            const scope = await authorize("operator");
            const monitor = await ownedMonitor(R.knex, scope, monitorID);
            const request = { action, monitorID, argument, name: monitor.name, active: Boolean(monitor.active) };
            await validateAction(R.knex, scope, request, monitor);
            return { ...request, timezone: scope.timezone };
        },
        async apply(request) {
            const change = await R.knex.transaction(async (tx) => {
                const scope = await authorize("operator", tx);
                const monitor = await ownedMonitor(tx, scope, request.monitorID);
                const now = Date.now();
                await validateAction(tx, scope, request, monitor, now);
                const { action, argument } = request;
                const result = { action, ownerID: scope.data_user_id, monitorID: monitor.id };
                if (action === "pause" || action === "resume") {
                    await ownedMonitors(tx, scope)
                        .where("id", monitor.id)
                        .update({ active: action === "resume" ? 1 : 0 });
                } else if (action === "maintenance") {
                    result.end = Math.floor(now / 1000) * 1000 + argument * 60000;
                    [result.maintenanceID] = await tx("maintenance").insert({
                        user_id: scope.data_user_id,
                        title: `Telegram · ${Array.from(String(monitor.name || "#" + monitor.id))
                            .slice(0, 130)
                            .join("")}`,
                        description: "Временное окно техработ из Telegram.",
                        active: 1,
                        strategy: "single",
                        timezone: "UTC",
                        start_date: sqlTime(now),
                        end_date: sqlTime(result.end),
                    });
                    await tx("monitor_maintenance").insert({
                        monitor_id: monitor.id,
                        maintenance_id: result.maintenanceID,
                    });
                } else {
                    result.maintenanceID = argument;
                    await tx("maintenance").where({ id: argument, user_id: scope.data_user_id }).update({ active: 0 });
                }
                const target = result.maintenanceID ? `${result.maintenanceID}:${monitor.id}` : monitor.id;
                await audit(tx, scope, actions[action], target);
                return { ...result, timezone: scope.timezone };
            });
            try {
                await services.sync(change);
            } catch {
                return { ...change, syncFailed: true };
            }
            return change;
        },
    };

    /**
     * @param {object} db Current connection or transaction
     * @param {object} scope Authorized project
     * @param {object} request Requested and confirmed monitor action
     * @param {object} monitor Current owned monitor
     * @param {number} now Current time
     * @returns {Promise<void>} Reject stale or conflicting actions
     */
    async function validateAction(db, scope, request, monitor, now = Date.now()) {
        const { action, argument } = request;
        if (
            !Object.hasOwn(actions, action) ||
            request.name !== monitor.name ||
            (action !== "end" && request.active !== Boolean(monitor.active))
        ) {
            throw problem("projectChanged");
        }
        if (action === "pause" || action === "resume") {
            if (Boolean(monitor.active) === (action === "resume")) {
                throw problem("projectChanged");
            }
        }
        if (action === "resume" || action === "maintenance") {
            const parentMap = await parents(db, scope);
            if (parentIsInactive(monitor, parentMap)) {
                throw problem("telegramParentPaused");
            }
            if (
                action === "maintenance" &&
                (!monitor.active ||
                    !durations.includes(argument) ||
                    (await underMaintenance(db, scope, monitor, parentMap, now)))
            ) {
                throw problem("telegramMaintenanceUnavailable");
            }
        }
        if (action === "end") {
            const query = activeWindows(db, scope, now).where({ "n.id": monitor.id, "m.id": argument });
            if (db.isTransaction) {
                query.forUpdate();
            }
            if (!(await query.first())) {
                throw problem("projectChanged");
            }
        }
    }
}

/**
 * @param {number} time UTC milliseconds
 * @returns {string} SQLite and MariaDB compatible UTC timestamp
 */
function sqlTime(time) {
    return heartbeatTime(time).slice(0, 19);
}

/**
 * @param {number} time UTC milliseconds
 * @returns {string} Saved heartbeat timestamp with millisecond precision
 */
function heartbeatTime(time) {
    return new Date(time).toISOString().replace("T", " ").slice(0, 23);
}

/**
 * @param {string} base Configured web panel URL
 * @param {string} pathname In-app location
 * @param {object} query Trusted panel navigation parameters
 * @returns {string|null} Web panel link
 */
function panelURL(base, pathname, query = {}) {
    try {
        const url = new URL(base);
        if (url.protocol === "https:" && !url.username && !url.password) {
            url.pathname = url.pathname.replace(/\/$/, "") + pathname;
            url.search = new URLSearchParams(query).toString();
            url.hash = "";
            return url.href;
        }
    } catch {
        // No configured web panel link.
    }
    return null;
}

module.exports = { projectMonitors, durations, actions };
