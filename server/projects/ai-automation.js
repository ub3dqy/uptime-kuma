const { R } = require("redbean-node");
const { permit, id, problem, audit } = require("./access");
const { currentServiceState, observationTime } = require("../../src/overview-state.ts");
const { parentIsInactive } = require("./store");

/**
 * A saved selection never silently expands when checks are added to the project.
 * The migration pins legacy policies; a missing selection authorizes nothing.
 * @param {object} policy Saved policy
 * @returns {number[]} Fixed selected identities
 * @throws {Error} Corrupt selection fails closed
 */
function selectedIDs(policy) {
    if (policy?.monitor_ids_json == null) return [];
    let ids;
    try {
        ids = JSON.parse(policy.monitor_ids_json);
    } catch {
        throw problem("projectInvalid");
    }
    if (
        !Array.isArray(ids) ||
        ids.length > 200 ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(ids).size !== ids.length
    )
        throw problem("projectInvalid");
    return ids;
}
/**
 * @param {object} policy Saved consent
 * @param {number} monitorID Current check
 * @returns {boolean} The current policy authorizes this exact check
 */
function includesMonitor(policy, monitorID) {
    const ids = selectedIDs(policy);
    return ids.includes(monitorID);
}

/**
 * @param {object} policy Stored consent
 * @param {object} scope Current membership and project
 * @param {object} config Current AI settings
 * @returns {boolean} Consent still applies to these exact settings and permissions
 */
function applies(policy, scope, config) {
    return Boolean(
        policy?.enabled &&
        policy.authorized_by === scope.actor_id &&
        scope.role === "admin" &&
        policy.project_revision === scope.revision &&
        policy.ai_revision === config?.revision &&
        config.state === "verified"
    );
}
/**
 * @param {object} monitor Current check
 * @param {object[]} beats Chronological saved observations
 * @param {number} now UTC time
 * @returns {string|null} Two fresh, continuous, matching observations
 */
function confirmedState(monitor, beats, now = Date.now()) {
    const pair = beats.slice(-2);
    if (pair.length !== 2) return null;
    const [previous, latest] = pair;
    const first = observationTime(previous.time);
    const last = observationTime(latest.time);
    const interval = Number(previous.check_interval);
    if (
        !previous.check_session ||
        previous.check_session !== latest.check_session ||
        first === null ||
        last === null ||
        first >= last ||
        !Number.isFinite(interval) ||
        interval <= 0 ||
        last - first > interval * 1000 + 1000 ||
        previous.status !== latest.status
    )
        return null;
    const { state } = currentServiceState(monitor, pair, now);
    return ["up", "down"].includes(state) ? state : null;
}
/**
 * @param {object} db Scoped database connection
 * @param {object} monitor Owned check
 * @param {Map} ancestors Current owned parents
 * @returns {Promise<boolean>} Current maintenance, including ancestors, without out-of-transaction reads
 */
async function underMaintenance(db, monitor, ancestors) {
    if ((await require("../site-work").signalForMonitor(monitor))?.state === "active") return true;
    if (!(await db.schema.hasTable("monitor_maintenance"))) return false;
    const ids = [];
    let current = monitor;
    while (current && !ids.includes(current.id)) {
        ids.push(current.id);
        current = ancestors.get(current.parent);
    }
    const rows = await db("monitor_maintenance as mm")
        .join("maintenance as m", "m.id", "mm.maintenance_id")
        .whereIn("mm.monitor_id", ids)
        .where("m.active", 1)
        .select("m.*");
    if (!rows.length) return false;
    const setting = await db("setting").where({ key: "serverTimezone" }).first();
    let configuredZone = setting?.value;
    try {
        configuredZone = JSON.parse(configuredZone);
    } catch {
        /* Existing raw settings remain supported. */
    }
    const serverZone = [
        process.env.TZ,
        configuredZone,
        new Intl.DateTimeFormat().resolvedOptions().timeZone,
        "UTC",
    ].find((value) => {
        if (typeof value !== "string" || !value) return false;
        try {
            new Intl.DateTimeFormat("en", { timeZone: value });
            return true;
        } catch {
            return false;
        }
    });
    const server = require("../uptime-kuma-server").UptimeKumaServer.getInstance();
    for (const row of rows) {
        const cached = server.getMaintenance(row.id);
        if (!cached) return true;
        const context = {
            active: row.active,
            strategy: row.strategy,
            start_date: row.start_date,
            end_date: row.end_date,
            beanMeta: cached.beanMeta,
            getTimezone: async () => (row.timezone && row.timezone !== "SAME_AS_SERVER" ? row.timezone : serverZone),
        };
        if (!["inactive", "scheduled", "ended"].includes(await cached.getStatus.call(context))) return true;
    }
    return false;
}
/**
 * @param {number} userID Human
 * @param {number} projectID Scope
 * @returns {Promise<object>} Secret-free policy and current applicability
 */
async function settings(userID, projectID) {
    const scope = await permit(userID, projectID, "admin");
    const row = await R.knex("project_ai_automation").where({ project_id: projectID }).first();
    const config = await R.knex("project_ai").where({ project_id: projectID }).first();
    const monitors = await R.knex("monitor")
        .where({ user_id: scope.data_user_id })
        .select("id", "name", "type", "active")
        .orderBy("id")
        .limit(201);
    const selected = row ? selectedIDs(row) : [];
    const available = monitors.filter((monitor) => monitor.type !== "group");
    const eligible = available.filter((monitor) => selected.includes(monitor.id));
    await permit(userID, projectID, "admin");
    return {
        revision: row?.revision || 0,
        enabled: Boolean(row?.enabled),
        active: applies(row, scope, config) && monitors.length <= 200 && eligible.length > 0,
        capacityExceeded: monitors.length > 200,
        dailyLimit: row?.daily_limit || 3,
        authorizedAt: row?.authorized_at || null,
        monitorIDs: selected,
        monitors: available.slice(0, 200),
    };
}
/**
 * @param {number} userID Human
 * @param {object} request Fresh, explicit future-data consent
 * @param {Function} guard Live authorization
 * @returns {Promise<object>} Saved policy
 */
async function save(userID, request, guard) {
    const projectID = id(request.projectID);
    await permit(userID, projectID, "admin");
    if (!(await require("../rate-limiter").loginRateLimiter.pass(null))) throw problem("projectRecoveryRateLimit");
    const auth = require("../auth");
    const human = await auth.findHumanByID(userID);
    if (
        typeof request.currentPassword !== "string" ||
        request.currentPassword.length > 1024 ||
        !human ||
        !require("../password-hash").verify(request.currentPassword, auth.passwordFor(human))
    )
        throw problem("projectRecoveryPassword");
    if (
        typeof request.enabled !== "boolean" ||
        !Number.isInteger(request.dailyLimit) ||
        request.dailyLimit < 1 ||
        request.dailyLimit > 50 ||
        !Array.isArray(request.monitorIDs) ||
        request.monitorIDs.length > 200 ||
        request.monitorIDs.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(request.monitorIDs).size !== request.monitorIDs.length ||
        (request.enabled && !request.monitorIDs.length) ||
        (request.enabled && request.consent !== true)
    )
        throw problem("projectInvalid");
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await permit(userID, projectID, "admin", tx);
        const row = await tx("project_ai_automation").where({ project_id: projectID }).first();
        const config = await tx("project_ai").where({ project_id: projectID }).first();
        if ((row?.revision || 0) !== request.revision) throw problem("projectChanged");
        if (request.enabled && (config?.state !== "verified" || config.mode === "off" || !config.secret_cipher))
            throw problem("projectAINeedProbe");
        const owned = request.monitorIDs.length
            ? await tx("monitor")
                  .where({ user_id: scope.data_user_id })
                  .whereIn("id", request.monitorIDs)
                  .whereNot("type", "group")
                  .select("id")
            : [];
        if (owned.length !== request.monitorIDs.length) throw problem("projectAccessDenied");
        const values = {
            revision: (row?.revision || 0) + 1,
            enabled: Number(request.enabled),
            authorized_by: userID,
            ai_revision: config?.revision,
            project_revision: scope.revision,
            daily_limit: request.dailyLimit,
            monitor_ids_json: JSON.stringify([...request.monitorIDs].sort((a, b) => a - b)),
            authorized_at: request.enabled ? Date.now() : null,
            updated_at: Date.now(),
        };
        if (row) await tx("project_ai_automation").where({ project_id: projectID }).update(values);
        else await tx("project_ai_automation").insert({ project_id: projectID, ...values });
        await tx("project_ai_job")
            .where({ project_id: projectID, trigger: "automatic", status: "queued" })
            .update({ status: "cancelled", error_code: "changed", updated_at: Date.now() });
        await audit(tx, scope, request.enabled ? "aiAutomationEnabled" : "aiAutomationDisabled");
        await guard(tx);
    });
    if (
        await R.knex("project_ai_job").where({ project_id: projectID, trigger: "automatic", status: "running" }).first()
    ) {
        require("./ai-service").cancelActive(projectID);
    }
    return settings(userID, projectID);
}
/**
 * @param {object} db Transaction
 * @param {object} scope Locked current membership
 * @param {object} config Current AI settings
 * @param {object} request Internal candidate
 * @param {string} day Project accounting day
 * @returns {Promise<void>} Claim the incident in the same transaction as its job
 */
async function claim(db, scope, config, request, day) {
    const policy = await db("project_ai_automation").where({ project_id: scope.id }).first();
    if (!applies(policy, scope, config) || policy.revision !== request.policyRevision) throw problem("projectChanged");
    if (!includesMonitor(policy, request.monitorID)) throw problem("projectAccessDenied");
    const incident = await db("project_ai_incident")
        .where({ project_id: scope.id, monitor_id: request.monitorID })
        .first();
    if (incident && !incident.armed) throw problem("projectAIAutomationDuplicate");
    const count = await db("project_ai_job")
        .where({ project_id: scope.id, bucket_day: day, trigger: "automatic" })
        .count({ n: "id" })
        .first();
    if (Number(count.n) >= policy.daily_limit) throw problem("projectAIDailyLimit");
    const monitor = await db("monitor").where({ id: request.monitorID, user_id: scope.data_user_id }).first();
    const ancestors = await db("monitor").where({ user_id: scope.data_user_id }).select("id", "parent", "active");
    if (!monitor || monitor.type === "group") throw problem();
    const parentMap = new Map(ancestors.map((row) => [row.id, row]));
    monitor.forceInactive = parentIsInactive(monitor, parentMap);
    if (await underMaintenance(db, monitor, parentMap)) throw problem("projectAIEvidenceChanged");
    const beats = await db("heartbeat")
        .where({ monitor_id: monitor.id })
        .orderBy("time", "desc")
        .orderBy("id", "desc")
        .limit(2);
    if (confirmedState(monitor, beats.reverse()) !== "down") throw problem("projectAIEvidenceChanged");
    if (incident)
        await db("project_ai_incident")
            .where({ project_id: scope.id, monitor_id: monitor.id })
            .update({ armed: 0, updated_at: Date.now() });
    else
        await db("project_ai_incident").insert({
            project_id: scope.id,
            monitor_id: monitor.id,
            armed: 0,
            updated_at: Date.now(),
        });
}
/**
 * @param {object} db Database/transaction
 * @param {object} job Claimed automatic work
 * @param {boolean} requireFailure Recheck incident eligibility immediately before spending
 * @returns {Promise<void>} Recheck consent before inference and before retaining its result
 */
async function validateJob(db, job, requireFailure = false) {
    if (job.trigger !== "automatic") return;
    const scope = await permit(job.user_id, job.project_id, "admin", db);
    const policy = await db("project_ai_automation").where({ project_id: job.project_id }).first();
    const config = await db("project_ai").where({ project_id: job.project_id }).first();
    if (
        !applies(policy, scope, config) ||
        policy.revision !== job.automation_revision ||
        !includesMonitor(policy, job.monitor_id)
    )
        throw problem("projectAccessDenied");
    if (requireFailure) {
        const monitor = await db("monitor").where({ id: job.monitor_id, user_id: scope.data_user_id }).first();
        if (!monitor) throw problem();
        const parents = await db("monitor").where({ user_id: scope.data_user_id }).select("id", "parent", "active");
        const map = new Map(parents.map((row) => [row.id, row]));
        monitor.forceInactive = parentIsInactive(monitor, map);
        const beats = await db("heartbeat")
            .where({ monitor_id: monitor.id })
            .orderBy("time", "desc")
            .orderBy("id", "desc")
            .limit(2);
        if (confirmedState(monitor, beats.reverse()) !== "down" || (await underMaintenance(db, monitor, map)))
            throw problem();
    }
}

class AutomationWorker {
    /** @returns {Promise<void>} Resume observation, never replay an already claimed incident. */
    async start() {
        this.stopped = false;
        this.timer = setInterval(() => this.tick(), 15000);
        this.timer.unref();
    }
    /** @returns {Promise<void>} Stop scheduling and await the current scan. */
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        await this.pending;
    }
    /** @returns {Promise<void>} Bounded scans, one project queue and durable per-incident claims. */
    async tick() {
        if (this.stopped || this.pending) return;
        this.pending = this.scan()
            .catch(() => {})
            .finally(() => {
                this.pending = null;
            });
        await this.pending;
    }
    /** @returns {Promise<void>} Inspect fresh observations only; no remote tools or commands. */
    async scan() {
        let policies = await R.knex("project_ai_automation")
            .where({ enabled: 1 })
            .where("project_id", ">", this.cursor || 0)
            .orderBy("project_id")
            .limit(100);
        if (!policies.length && this.cursor) {
            this.cursor = 0;
            policies = await R.knex("project_ai_automation").where({ enabled: 1 }).orderBy("project_id").limit(100);
        }
        this.cursor = policies.length === 100 ? policies.at(-1).project_id : 0;
        for (const policy of policies) {
            if (this.stopped) break;
            try {
                const scope = await permit(policy.authorized_by, policy.project_id, "admin");
                const config = await R.knex("project_ai").where({ project_id: scope.id }).first();
                if (!applies(policy, scope, config)) continue;
                const monitors = await R.knex("monitor")
                    .where({ user_id: scope.data_user_id })
                    .orderBy("id")
                    .limit(201);
                if (monitors.length > 200) continue; // No silently incomplete project automation.
                const ancestors = new Map(monitors.map((monitor) => [monitor.id, monitor]));
                for (const monitor of monitors) {
                    if (this.stopped) break;
                    if (!includesMonitor(policy, monitor.id)) continue;
                    monitor.forceInactive = parentIsInactive(monitor, ancestors);
                    if (!monitor.active || monitor.forceInactive || monitor.type === "group") continue;
                    if (await underMaintenance(R.knex, monitor, ancestors)) continue;
                    const beats = await R.knex("heartbeat")
                        .where({ monitor_id: monitor.id })
                        .orderBy("time", "desc")
                        .orderBy("id", "desc")
                        .limit(2);
                    const state = confirmedState(monitor, beats.reverse());
                    if (state === "up") {
                        await R.knex.transaction(async (tx) => {
                            await permit(policy.authorized_by, scope.id, "admin", tx);
                            const fresh = await tx("heartbeat")
                                .where({ monitor_id: monitor.id })
                                .orderBy("time", "desc")
                                .orderBy("id", "desc")
                                .limit(2);
                            if (confirmedState(monitor, fresh.reverse()) === "up") {
                                await tx("project_ai_incident")
                                    .where({ project_id: scope.id, monitor_id: monitor.id, armed: 0 })
                                    .update({ armed: 1, updated_at: Date.now() });
                            }
                        });
                    } else if (state === "down") {
                        const incident = await R.knex("project_ai_incident")
                            .where({ project_id: scope.id, monitor_id: monitor.id })
                            .first();
                        if (incident && !incident.armed) continue;
                        const ai = require("./ai-service");
                        const preview = await ai.prepare(policy.authorized_by, {
                            projectID: scope.id,
                            monitorID: monitor.id,
                        });
                        try {
                            await ai.enqueue(
                                policy.authorized_by,
                                {
                                    projectID: scope.id,
                                    monitorID: monitor.id,
                                    kind: "diagnosis",
                                    revision: preview.revision,
                                    evidenceHash: preview.hash,
                                },
                                async (db) => {
                                    const current = await permit(policy.authorized_by, scope.id, "admin", db);
                                    const latest = await db("project_ai_automation")
                                        .where({ project_id: scope.id })
                                        .first();
                                    if (!applies(latest, current, config) || latest.revision !== policy.revision)
                                        throw problem("projectChanged");
                                },
                                { policyRevision: policy.revision, monitorID: monitor.id }
                            );
                        } catch (error) {
                            if (
                                ![
                                    "projectAIBusy",
                                    "projectAIDailyLimit",
                                    "projectAIAutomationDuplicate",
                                    "projectAIEvidenceChanged",
                                ].includes(error.message)
                            )
                                throw error;
                        }
                    }
                }
            } catch {
                /* Safe retry on observations only; a claimed or uncertain job is never replayed. */
            }
        }
    }
}

module.exports = {
    settings,
    save,
    claim,
    validateJob,
    confirmedState,
    underMaintenance,
    AutomationWorker,
    worker: new AutomationWorker(),
};
