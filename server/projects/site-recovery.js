const { randomBytes } = require("node:crypto");
const { R } = require("redbean-node");
const { permit, id, problem, audit } = require("./access");
const legacy = require("./recovery");
const client = require("./site-recovery-client");
const { parentIsInactive } = require("./store");
const { currentServiceState, observationTime, issueExplanation } = require("../../src/overview-state.ts");

const openStatuses = [
    "queued",
    "backing_up",
    "applying",
    "verifying",
    "rollback_queued",
    "rolling_back",
    "verifying_rollback",
];
const adverse = ["rolled_back", "rollback_unhealthy", "conflict", "failed", "uncertain"];
const safeCode = (error) =>
    /^project(?:Site)?Recovery[A-Z][a-zA-Z]+$/.test(error?.message) ? error.message : "projectSiteRecoveryUnavailable";
const json = (value) => (value ? JSON.parse(value) : null);

/**
 * @param {object} scope Authorized project
 * @param {number} monitorID Exact owned check
 * @param {string} targetID Installer recipe
 * @param {object} db Connection
 * @returns {Promise<object>} Live context, including personal projects explicitly installed for this owner
 */
async function context(scope, monitorID, targetID, db = R.knex) {
    const target = client
        .profiles()
        .find(
            (item) =>
                item.projectID === scope.id &&
                item.monitorID === monitorID &&
                item.id === targetID &&
                item.ownerID === scope.owner_id
        );
    const monitor = await db("monitor")
        .where({ id: id(monitorID), user_id: scope.data_user_id })
        .first();
    if (
        !target ||
        !monitor ||
        monitor.type !== "http" ||
        monitor.url !== target.checkURL ||
        (monitor.method || "GET") !== "GET" ||
        monitor.ignore_tls ||
        monitor.upside_down ||
        monitor.interval < 20 ||
        monitor.interval > 60 ||
        target.verifySeconds < monitor.interval * 2 + 5
    )
        throw problem("projectRecoveryNotConfigured");
    if (monitor.parent) {
        const parents = await db("monitor").where({ user_id: scope.data_user_id }).select("id", "active", "parent");
        monitor.forceInactive = parentIsInactive(monitor, new Map(parents.map((row) => [row.id, row])));
    }
    const beats = await db("heartbeat").where({ monitor_id: monitorID }).orderBy("id", "desc").limit(8);
    return { target, monitor, beats, current: currentServiceState(monitor, [...beats].reverse()) };
}

/**
 * @param {object} value Current scope
 * @param {object} checked Host facts
 * @returns {void} Reject incomplete or mismatched transport replies
 * @throws {Error} Invalid host receipt
 */
function checkedReply(value, checked) {
    if (
        checked?.ok !== true ||
        checked.targetID !== value.target.id ||
        checked.action !== value.target.action ||
        !/^[a-f0-9]{64}$/.test(checked.currentHash) ||
        !/^[a-f0-9]{64}$/.test(checked.policyHash) ||
        typeof checked.eligible !== "boolean"
    )
        throw problem("projectSiteRecoveryPolicy");
}

/**
 * @param {object} scope Project
 * @param {object} monitor Check
 * @param {string} targetID Fixed action
 * @param {object} db Connection
 * @returns {Promise<object>} Secret-free evidence for explicit owner preview
 */
async function capability(scope, monitor, targetID, db = R.knex) {
    const value = await context(scope, monitor.id, targetID, db);
    // AI enqueue calls this on its owning transaction. Do not acquire the global
    // SQLite connection from inside that transaction (it has a one-slot pool).
    if (
        value.current.state !== "down" ||
        value.current.latest?.status !== 0 ||
        !value.current.latest?.check_session ||
        !monitor.active ||
        monitor.forceInactive
    )
        throw problem("projectRecoveryFailureRequired");
    const checked = await client.request(value.target, "inspect");
    checkedReply(value, checked);
    if (!checked.eligible) throw problem("projectSiteRecoveryNotApplicable");
    return {
        driver: "site",
        targetID,
        scenario: value.target.action,
        currentHash: checked.currentHash,
        policyFingerprint: value.target.fingerprint,
        hostPolicyHash: checked.policyHash,
        monitorFingerprint: legacy.fingerprint(monitor),
        originID: value.current.latest.id,
        originTime: observationTime(value.current.latest.time),
        checkSession: value.current.latest.check_session,
        facts: checked.facts,
        limitations: [
            "Only the fixed installed action is available. No commands, file paths, data or secrets are shared. A local failing health check supports a limited recovery attempt, not a proven root cause. Owner approval, verified backup and two fresh successful monitoring observations are required.",
            value.target.action === "restart_service"
                ? "A restart cannot restore an old process or interrupted requests. Rollback preserves the same configuration and version and restores the former running/stopped state. The database backup is retained and never automatically restored."
                : "Only the administrator-approved index file of this same release can be restored; no other files or release can be changed.",
        ],
    };
}

/**
 * @param {object} scope Current authorized project
 * @param {object} monitor Current owned check
 * @param {string} targetID Fixed installed target
 * @param {object} evidence Host inspection completed before the transaction
 * @param {object} db Owning transaction
 * @returns {Promise<object>} Exact still-current incident without SSH inside a database transaction
 */
async function retainedCapability(scope, monitor, targetID, evidence, db) {
    const value = await context(scope, monitor.id, targetID, db);
    if (
        evidence.driver !== "site" ||
        evidence.targetID !== targetID ||
        evidence.policyFingerprint !== value.target.fingerprint ||
        evidence.monitorFingerprint !== legacy.fingerprint(monitor) ||
        value.current.state !== "down" ||
        evidence.originID !== value.current.latest?.id ||
        evidence.checkSession !== value.current.latest?.check_session ||
        !monitor.active ||
        monitor.forceInactive
    )
        throw problem("projectAIEvidenceChanged");
    return evidence;
}

/**
 * @param {object} scope Current scope
 * @param {number} aiJobID Proposal
 * @param {object} db Connection
 * @returns {Promise<object>} Current completed recommendation, bound to retained incident
 */
async function source(scope, aiJobID, db = R.knex) {
    const job = await db("project_ai_job")
        .where({ id: id(aiJobID), project_id: scope.id, kind: "recovery", status: "completed" })
        .first();
    const ai = await db("project_ai").where({ project_id: scope.id, state: "verified" }).first();
    if (
        !job ||
        !ai ||
        job.revision !== ai.revision ||
        job.project_revision !== scope.revision ||
        Number(job.updated_at) < Date.now() - 900000
    )
        throw problem("projectRecoveryStale");
    const evidence = json(job.input_json);
    const result = json(job.result_json);
    if (
        evidence?.recovery?.driver !== "site" ||
        evidence.state !== "down" ||
        !client.actions.includes(evidence.recovery.scenario) ||
        result?.remediation?.action !== evidence.recovery.scenario
    )
        throw problem("projectRecoveryNoRecommendation");
    return { job, evidence };
}

/**
 * @param {object} value Live context
 * @param {object} evidence Original consented incident
 * @param {object} db Connection
 * @returns {Promise<void>} Same continuous incident and unchanged check
 */
async function sameIncident(value, evidence, db = R.knex) {
    await legacy.requireFailure(value);
    const saved = evidence.recovery;
    if (
        saved.policyFingerprint !== value.target.fingerprint ||
        saved.scenario !== value.target.action ||
        saved.monitorFingerprint !== legacy.fingerprint(value.monitor) ||
        issueExplanation("down", value.current.latest.msg) !== evidence.reason
    )
        throw problem("projectRecoveryStale");
    const origin = await db("heartbeat").where({ id: saved.originID, monitor_id: value.monitor.id, status: 0 }).first();
    if (
        !origin ||
        observationTime(origin.time) !== saved.originTime ||
        !origin.check_session ||
        origin.check_session !== saved.checkSession ||
        origin.check_session !== value.current.latest.check_session
    )
        throw problem("projectRecoveryStale");
    if (
        await db("heartbeat")
            .where({ monitor_id: value.monitor.id })
            .where("id", ">", origin.id)
            .whereNot("status", 0)
            .first()
    )
        throw problem("projectRecoveryStale");
}

/**
 * @param {object} row Retained recovery
 * @returns {object} Public history without transport paths or secrets
 */
function publicJob(row) {
    const plan = json(row.plan_json);
    const backup = json(row.backup_json);
    return {
        id: row.id,
        aiJobID: row.ai_job_id,
        targetID: row.target_id,
        monitorID: row.monitor_id,
        status: row.status,
        revision: row.revision,
        planHash: row.plan_hash,
        title: plan.title,
        action: plan.action,
        beforeHash: plan.beforeHash,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
        approvedAt: row.approved_at === null ? null : Number(row.approved_at),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at),
        cancelRequested: Boolean(row.cancel_requested),
        errorCode: row.error_code,
        backup,
        snapshotAt: backup?.savedAt || null,
        appliedAt: json(row.applied_json)?.at || null,
        verification: json(row.verification_json),
        rollback: json(row.rollback_json),
        rollbackVerification: json(row.rollback_json),
        canRollback: Boolean(
            backup && row.applied_json && ["succeeded", "conflict", "failed", "uncertain"].includes(row.status)
        ),
    };
}

/**
 * @param {number} userID Actor
 * @param {number} projectID Scope
 * @returns {Promise<object>} Installed capabilities and durable history
 */
async function overview(userID, projectID) {
    const scope = await permit(userID, projectID);
    let targets = [];
    let configurationError = false;
    try {
        targets = client
            .profiles()
            .filter((item) => item.projectID === scope.id && item.ownerID === scope.owner_id)
            .map(({ id: targetID, title, monitorID, action, verifySeconds }) => ({
                id: targetID,
                title,
                monitorID,
                action,
                verifySeconds,
            }));
    } catch {
        configurationError = true;
    }
    if (targets.length && !worker.ready) {
        try {
            await worker.start();
        } catch {
            configurationError = true;
        }
    }
    const jobs = await R.knex("project_site_recovery").where({ project_id: projectID }).orderBy("id", "desc").limit(30);
    const breakers = await R.knex("project_site_recovery_target")
        .where({ project_id: projectID })
        .whereNotNull("blocked_at")
        .select("target_id", "blocked_at");
    await permit(userID, projectID);
    return {
        targets,
        jobs: jobs.map(publicJob),
        breakers,
        configured: targets.length > 0,
        configurationError,
        executorReady: worker.ready,
        isOwner: scope.owner_id === userID && scope.role === "admin",
    };
}

/**
 * @param {number} userID Operator
 * @param {object} request Completed AI proposal
 * @param {Function} guard Login
 * @returns {Promise<object>} Exact expiring plan; no server change
 */
async function createPlan(userID, request, guard) {
    const scope = await permit(userID, id(request.projectID), "operator");
    const { job, evidence } = await source(scope, request.aiJobID);
    const value = await context(scope, job.monitor_id, evidence.recovery.targetID);
    await sameIncident(value, evidence);
    const peek = await client.request(value.target, "inspect");
    checkedReply(value, peek);
    if (
        !peek.eligible ||
        peek.currentHash !== evidence.recovery.currentHash ||
        peek.policyHash !== evidence.recovery.hostPolicyHash
    )
        throw problem("projectRecoveryDrift");
    const plan = {
        title: value.target.title,
        action: value.target.action,
        beforeHash: peek.currentHash,
        hostPolicyHash: peek.policyHash,
        targetFingerprint: value.target.fingerprint,
        monitorFingerprint: legacy.fingerprint(value.monitor),
        aiRevision: job.revision,
        checkSession: value.current.latest.check_session,
    };
    const planHash = client.digest(
        JSON.stringify({ projectID: scope.id, aiJobID: job.id, ownerID: scope.owner_id, ...plan })
    );
    const savedID = await R.knex.transaction(async (tx) => {
        await guard(tx);
        const current = await permit(userID, scope.id, "operator", tx);
        if (current.revision !== scope.revision) throw problem("projectRecoveryStale");
        const existing = await tx("project_site_recovery").where({ ai_job_id: job.id }).first();
        if (existing) return existing.id;
        await tx("project_site_recovery_target")
            .insert({ project_id: scope.id, target_id: value.target.id })
            .onConflict(["project_id", "target_id"])
            .ignore();
        const target = await tx("project_site_recovery_target")
            .where({ project_id: scope.id, target_id: value.target.id })
            .first();
        if (target.open_id || target.blocked_at) throw problem("projectRecoveryBlocked");
        const [recoveryID] = await tx("project_site_recovery").insert({
            project_id: scope.id,
            monitor_id: job.monitor_id,
            ai_job_id: job.id,
            target_id: value.target.id,
            remote_id: randomBytes(16).toString("hex"),
            status: "planned",
            created_by: userID,
            project_revision: scope.revision,
            plan_json: JSON.stringify(plan),
            plan_hash: planHash,
            created_at: Date.now(),
            expires_at: Date.now() + 300000,
            updated_at: Date.now(),
        });
        await tx("project_site_recovery_target")
            .where({ project_id: scope.id, target_id: value.target.id })
            .update({ open_id: recoveryID });
        await audit(tx, current, "siteRecoveryPlanned", recoveryID);
        await guard(tx);
        return recoveryID;
    });
    await notify(savedID);
    return publicJob(await R.knex("project_site_recovery").where({ id: savedID }).first());
}

/**
 * @param {number} userID Owner
 * @param {object} request Exact reviewed plan
 * @param {Function} guard Login
 * @returns {Promise<object>} Idempotently queued action, still no forward change here
 */
async function approve(userID, request, guard) {
    const scope = await legacy.owner(userID, id(request.projectID));
    await legacy.proof(userID, scope.id, request.password);
    if (request.confirm !== true || !worker.ready) throw problem("projectRecoveryExecutor");
    const row = await R.knex("project_site_recovery")
        .where({ id: id(request.id), project_id: scope.id })
        .first();
    if (!row || row.plan_hash !== request.planHash) throw problem("projectRecoveryStale");
    if (row.approved_at) return publicJob(row);
    const { job, evidence } = await source(scope, row.ai_job_id);
    const value = await context(scope, job.monitor_id, row.target_id);
    await sameIncident(value, evidence);
    const peek = await client.request(value.target, "inspect");
    const plan = json(row.plan_json);
    checkedReply(value, peek);
    if (!peek.eligible || peek.currentHash !== plan.beforeHash || peek.policyHash !== plan.hostPolicyHash)
        throw problem("projectRecoveryDrift");
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const current = await legacy.owner(userID, scope.id, tx);
        const saved = await tx("project_site_recovery").where({ id: row.id }).first();
        if (saved.approved_at) return;
        if (
            saved.status !== "planned" ||
            saved.revision !== request.revision ||
            saved.expires_at <= Date.now() ||
            current.revision !== row.project_revision
        )
            throw problem("projectRecoveryStale");
        const target = await tx("project_site_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .first();
        if (target.open_id !== row.id || target.blocked_at || target.last_action_at > Date.now() - 1800000)
            throw problem("projectRecoveryBlocked");
        const attempts = await tx("project_site_recovery")
            .where({ project_id: scope.id, target_id: row.target_id })
            .where("approved_at", ">", Date.now() - 86400000)
            .count({ n: "id" })
            .first();
        if (Number(attempts.n) >= 3) throw problem("projectRecoveryRateLimit");
        await tx("project_site_recovery")
            .where({ id: row.id, status: "planned" })
            .update({
                approved_by: userID,
                approved_at: Date.now(),
                status: "queued",
                revision: saved.revision + 1,
                updated_at: Date.now(),
            });
        await audit(tx, current, "siteRecoveryApproved", row.id);
        await guard(tx);
    });
    return publicJob(await R.knex("project_site_recovery").where({ id: row.id }).first());
}

/**
 * @param {number} userID Owner
 * @param {object} request Current row
 * @param {Function} guard Login
 * @returns {Promise<void>} Cancellation, compensating after any mutation
 */
async function cancel(userID, request, guard) {
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await legacy.owner(userID, id(request.projectID), tx);
        const row = await tx("project_site_recovery")
            .where({ id: id(request.id), project_id: scope.id })
            .first();
        if (!row || row.revision !== request.revision || !["planned", ...openStatuses].includes(row.status))
            throw problem("projectRecoveryStale");
        const draft = row.status === "planned";
        await tx("project_site_recovery")
            .where({ id: row.id })
            .update({
                cancel_requested: 1,
                ...(draft ? { status: "cancelled", finished_at: Date.now() } : {}),
                revision: row.revision + 1,
                updated_at: Date.now(),
            });
        if (draft)
            await tx("project_site_recovery_target")
                .where({ project_id: scope.id, target_id: row.target_id, open_id: row.id })
                .update({ open_id: null });
        await audit(tx, scope, "siteRecoveryCancelled", row.id);
        await guard(tx);
    });
}

/**
 * @param {number} userID Owner
 * @param {object} request Exact retained point
 * @param {Function} guard Login
 * @returns {Promise<void>} Queue compensating action after fresh owner proof
 */
async function rollback(userID, request, guard) {
    await legacy.proof(userID, id(request.projectID), request.password);
    if (request.confirm !== true || !worker.ready) throw problem("projectRecoveryExecutor");
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await legacy.owner(userID, request.projectID, tx);
        const row = await tx("project_site_recovery")
            .where({ id: id(request.id), project_id: scope.id })
            .first();
        if (
            !row ||
            !publicJob(row).canRollback ||
            row.plan_hash !== request.planHash ||
            row.revision !== request.revision
        )
            throw problem("projectRecoveryStale");
        const target = await tx("project_site_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .first();
        if (target.open_id) throw problem("projectRecoveryBlocked");
        await tx("project_site_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .update({ open_id: row.id });
        await tx("project_site_recovery")
            .where({ id: row.id })
            .update({ status: "rollback_queued", revision: row.revision + 1, updated_at: Date.now() });
        await audit(tx, scope, "siteRecoveryRollbackRequested", row.id);
        await guard(tx);
    });
}

/**
 * @param {number} userID Owner
 * @param {object} request Fixed target
 * @param {Function} guard Login
 * @returns {Promise<void>} Clear acknowledgement gate; host cooldown and history survive
 */
async function reset(userID, request, guard) {
    await legacy.proof(userID, id(request.projectID), request.password);
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await legacy.owner(userID, request.projectID, tx);
        const target = await tx("project_site_recovery_target")
            .where({ project_id: scope.id, target_id: request.targetID })
            .first();
        if (!target || target.open_id) throw problem("projectRecoveryBlocked");
        await tx("project_site_recovery_target")
            .where({ project_id: scope.id, target_id: request.targetID })
            .update({ blocked_at: null });
        await audit(tx, scope, "siteRecoveryBlockCleared", request.targetID);
        await guard(tx);
    });
}

/**
 * @param {number} jobID Retained job
 * @returns {Promise<void>} Notification failure never repeats a site action
 */
async function notify(jobID) {
    try {
        await require("../notification-delivery").notifySiteRecovery(jobID);
    } catch {
        /* Queue failure is visible independently of site execution. */
    }
}

/** Globally leased executor. Every external side effect is durable, signed and once-only at the host. */
class SiteRecoveryWorker {
    /**
     * @param {object} options Isolated clock/sleep for regression checks
     */
    constructor(options = {}) {
        this.now = options.now || Date.now;
        this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.ready = false;
    }
    /**
     * @returns {Promise<void>} Acquire a renewable database lease without stealing a live worker
     */
    async start() {
        if (this.timer || !client.profiles().length) return;
        this.token = randomBytes(32).toString("hex");
        this.stopped = false;
        await this.lease();
        this.timer = setInterval(
            () =>
                this.tick().catch(() => {
                    this.ready = false;
                }),
            2000
        );
        this.timer.unref();
    }
    /**
     * @returns {Promise<boolean>} Renew only our lease or atomically take an expired one
     */
    async lease() {
        return R.knex.transaction(async (tx) => {
            await tx("project_site_recovery_worker")
                .insert({ id: 1, token: this.token, lease_until: this.now() + 30000 })
                .onConflict("id")
                .ignore();
            await tx("project_site_recovery_worker")
                .where({ id: 1 })
                .where((query) => query.where({ token: this.token }).orWhere("lease_until", "<", this.now()))
                .update({ token: this.token, lease_until: this.now() + 30000 });
            const saved = await tx("project_site_recovery_worker").where({ id: 1 }).first();
            this.ready = saved.token === this.token && Number(saved.lease_until) > this.now();
            return this.ready;
        });
    }
    /**
     * @returns {Promise<void>} Recheck lease immediately before root-side operations
     */
    async ownsLease() {
        const saved = await R.knex("project_site_recovery_worker").where({ id: 1, token: this.token }).first();
        if (!this.ready || !saved || Number(saved.lease_until) <= this.now()) {
            this.ready = false;
            throw problem("projectRecoveryExecutor");
        }
    }
    /**
     * @returns {Promise<void>} Drain bounded work before releasing the same lease
     */
    async stop() {
        if (!this.token) return;
        this.stopped = true;
        try {
            await this.task;
        } finally {
            clearInterval(this.timer);
            this.timer = null;
            await R.knex("project_site_recovery_worker").where({ id: 1, token: this.token }).delete();
            this.ready = false;
            this.token = null;
        }
    }
    /**
     * @returns {Promise<void>} Renew even while a root backup or verification is pending
     */
    async tick() {
        if (this.renewing || (this.stopped && !this.task)) return;
        this.renewing = true;
        try {
            if (!(await this.lease()) || this.task || this.stopped) return;
            const expired = await R.knex("project_site_recovery")
                .where({ status: "planned" })
                .where("expires_at", "<=", this.now());
            for (const row of expired) await this.finish(row, "cancelled", "projectRecoveryStale");
            const row = await R.knex("project_site_recovery").whereIn("status", openStatuses).orderBy("id").first();
            if (row)
                this.task = this.run(row)
                    .catch(() => {})
                    .finally(() => {
                        this.task = null;
                    });
        } finally {
            this.renewing = false;
        }
    }
    /**
     * @param {object} row Job
     * @param {string} status State
     * @param {object} extra Receipts
     * @returns {Promise<void>} Persist before next side effect
     */
    async transition(row, status, extra = {}) {
        await this.ownsLease();
        await R.knex("project_site_recovery")
            .where({ id: row.id })
            .update({ ...extra, status, revision: R.knex.raw("revision + 1"), updated_at: this.now() });
    }
    /**
     * @param {object} row Job
     * @param {string} status Outcome
     * @param {string|null} errorCode Fixed code
     * @returns {Promise<void>} Release scope, retain receipts, block adverse repeats
     */
    async finish(row, status, errorCode = null) {
        await this.ownsLease();
        await R.knex.transaction(async (tx) => {
            await tx("project_site_recovery")
                .where({ id: row.id })
                .update({
                    status,
                    error_code: errorCode,
                    revision: R.knex.raw("revision + 1"),
                    updated_at: this.now(),
                    finished_at: this.now(),
                });
            await tx("project_site_recovery_target")
                .where({ project_id: row.project_id, target_id: row.target_id, open_id: row.id })
                .update({ open_id: null, ...(adverse.includes(status) ? { blocked_at: this.now() } : {}) });
        });
        await notify(row.id);
    }
    /**
     * @param {object} row Approved row
     * @returns {Promise<object>} Immutable installed capability; revocation blocks forward work
     */
    async forward(row) {
        await this.ownsLease();
        const saved = await R.knex("project_site_recovery").where({ id: row.id }).first();
        const scope = await legacy.owner(row.approved_by, row.project_id);
        if (saved.cancel_requested || scope.revision !== row.project_revision)
            throw problem("projectRecoveryCancelled");
        const { evidence } = await source(scope, row.ai_job_id);
        const value = await context(scope, row.monitor_id, row.target_id);
        await sameIncident(value, evidence);
        if (json(row.plan_json).targetFingerprint !== value.target.fingerprint) throw problem("projectRecoveryDrift");
        return value;
    }
    /**
     * @param {object} row Retained row
     * @returns {object} Root-verifiable approved identity
     */
    args(row) {
        const plan = json(row.plan_json);
        return {
            jobID: row.remote_id,
            planHash: row.plan_hash,
            expectedHash: plan.beforeHash,
            policyHash: plan.hostPolicyHash,
            approvedAt: Number(row.approved_at),
        };
    }
    /**
     * @param {object} row Approved row
     * @param {object} target Fixed recipe
     * @param {string} operation Closed command
     * @returns {Promise<object>} Bound once-only host receipt
     */
    async remote(row, target, operation) {
        await this.ownsLease();
        const result = await client.request(target, operation, this.args(row));
        if (
            result?.ok !== true ||
            result.jobID !== row.remote_id ||
            result.planHash !== row.plan_hash ||
            result.targetID !== row.target_id
        )
            throw problem("projectSiteRecoveryPolicy");
        return result;
    }
    /**
     * @param {object} row Job
     * @param {object} target Exact installed target
     * @param {number} at After remote completion
     * @param {number} lastID Ignore earlier observations
     * @param {boolean} rollback Compensation
     * @returns {Promise<object>} Two fresh continuous successes, no missing-check assumptions
     */
    async observe(row, target, at, lastID, rollback = false) {
        const deadline = this.now() + target.verifySeconds * 1000;
        const success = [];
        const observations = [];
        let cursor = lastID;
        while (this.now() < deadline) {
            await this.ownsLease();
            const saved = await R.knex(this.observationTable || "project_site_recovery").where({ id: row.id }).first();
            const scope = await legacy.owner(row.approved_by, row.project_id);
            const value = await context(scope, row.monitor_id, row.target_id);
            const plan = json(row.plan_json);
            if (
                (!rollback && saved.cancel_requested) ||
                scope.revision !== row.project_revision ||
                legacy.fingerprint(value.monitor) !== plan.monitorFingerprint ||
                value.target.fingerprint !== plan.targetFingerprint ||
                !value.monitor.active ||
                value.monitor.forceInactive
            )
                throw problem("projectRecoveryCancelled");
            const beats = await R.knex("heartbeat")
                .where({ monitor_id: row.monitor_id })
                .where("id", ">", cursor)
                .orderBy("id")
                .limit(100);
            const now = this.now();
            for (const beat of beats) {
                cursor = beat.id;
                const time = observationTime(beat.time);
                if (time === null || time < at || time > now) {
                    success.length = 0;
                    continue;
                }
                observations.push({
                    id: beat.id,
                    time: new Date(time).toISOString(),
                    status: beat.status,
                });
                if (!beat.check_session || beat.status !== 1) {
                    success.length = 0;
                    continue;
                }
                const previous = success.at(-1);
                const gap = previous ? time - observationTime(previous.time) : 0;
                if (
                    previous &&
                    (previous.check_session !== beat.check_session || gap <= 0 || gap > value.monitor.interval * 1750 + 5000)
                )
                    success.length = 0;
                success.push(beat);
                if (success.length > 2) success.shift();
            }
            // Evaluate the latest observations together. An earlier pair of successes
            // cannot mask a newer failure already stored in this batch.
            if (
                beats.length < 100 &&
                success.length === 2 &&
                currentServiceState(value.monitor, [success[1]], now).state === "up" &&
                !(await legacy.underMaintenance(row.monitor_id))
            )
                return {
                    healthy: true,
                    observations: success.map((item) => ({
                        id: item.id,
                        time: new Date(observationTime(item.time)).toISOString(),
                        status: 1,
                    })),
                };
            await this.sleep(2000);
        }
        return { healthy: false, observations: observations.slice(-8) };
    }
    /**
     * @param {object} row Retained point
     * @param {object} target Exact target
     * @param {string} reason Failure trigger
     * @returns {Promise<void>} Compensate a known application; never replay forward work
     */
    async compensate(row, target, reason) {
        try {
            const state = await this.remote(row, target, "status");
            if (["new", "backing_up", "backed_up"].includes(state.phase)) {
                await this.finish(row, reason === "projectRecoveryCancelled" ? "cancelled" : "failed", reason);
                return;
            }
            if (!["applied", "applying", "rolled_back"].includes(state.phase))
                throw problem("projectSiteRecoveryUncertain");
            await this.transition(
                row,
                "rolling_back",
                state.phase === "applied" ? { applied_json: JSON.stringify(state) } : {}
            );
            const reverted = state.phase === "rolled_back" ? state : await this.remote(row, target, "rollback");
            if (reverted.phase !== "rolled_back" || !/^[a-f0-9]{64}$/.test(reverted.rollbackHash))
                throw problem("projectSiteRecoveryUncertain");
            const at = this.now();
            const last = await R.knex("heartbeat").where({ monitor_id: row.monitor_id }).orderBy("id", "desc").first();
            await this.transition(row, "verifying_rollback", {
                rollback_json: JSON.stringify({ receipt: reverted, healthy: false, observations: [] }),
            });
            const observed = await this.observe(row, target, at, last?.id || 0, true);
            const peek = await client.request(target, "inspect");
            if (peek.currentHash !== reverted.rollbackHash || peek.policyHash !== json(row.plan_json).hostPolicyHash)
                throw problem("projectSiteRecoveryConflict");
            await this.transition(row, "verifying_rollback", {
                rollback_json: JSON.stringify({ receipt: reverted, ...observed }),
            });
            await this.finish(row, observed.healthy ? "rolled_back" : "rollback_unhealthy", reason);
        } catch (error) {
            await this.finish(row, "uncertain", safeCode(error));
        }
    }
    /**
     * @param {object} row Claimed row
     * @returns {Promise<void>} Backup first, guarded action, independent verification or compensation
     */
    async run(row) {
        let target;
        try {
            target = client
                .profiles()
                .find(
                    (item) =>
                        item.projectID === row.project_id &&
                        item.id === row.target_id &&
                        item.fingerprint === json(row.plan_json).targetFingerprint
                );
            if (!target) throw problem("projectRecoveryDrift");
            if (row.status !== "queued") {
                await this.compensate(row, target, "projectRecoveryInterrupted");
                return;
            }
            const value = await this.forward(row);
            target = value.target;
            await this.transition(row, "backing_up");
            const backup = await this.remote(row, target, "backup");
            if (
                backup.phase !== "backed_up" ||
                !/^[a-f0-9]{64}$/.test(backup.backup?.digest) ||
                backup.backup.expiresAt !== null
            )
                throw problem("projectSiteRecoveryBackup");
            await this.transition(row, "backing_up", {
                backup_json: JSON.stringify({ ...backup.backup, savedAt: this.now() }),
            });
            await this.forward(row);
            await this.transition(row, "applying");
            await R.knex("project_site_recovery_target")
                .where({ project_id: row.project_id, target_id: row.target_id })
                .update({ last_action_at: this.now() });
            const applied = await this.remote(row, target, "apply");
            if (applied.phase !== "applied" || !/^[a-f0-9]{64}$/.test(applied.afterHash))
                throw problem("projectSiteRecoveryUncertain");
            const at = this.now();
            const last = await R.knex("heartbeat").where({ monitor_id: row.monitor_id }).orderBy("id", "desc").first();
            await this.transition(row, "verifying", { applied_json: JSON.stringify(applied) });
            const observed = await this.observe(row, target, at, last?.id || 0);
            if (!observed.healthy) throw problem("projectRecoveryNoObservations");
            const peek = await client.request(target, "inspect");
            if (peek.currentHash !== applied.afterHash || peek.policyHash !== json(row.plan_json).hostPolicyHash)
                throw problem("projectSiteRecoveryConflict");
            const saved = await R.knex("project_site_recovery").where({ id: row.id }).first();
            if (saved.cancel_requested) throw problem("projectRecoveryCancelled");
            await this.transition(row, "verifying", { verification_json: JSON.stringify(observed) });
            await this.finish(row, "succeeded");
        } catch (error) {
            const saved = await R.knex("project_site_recovery").where({ id: row.id }).first();
            if (!target || saved.status === "queued") {
                await this.finish(
                    saved,
                    safeCode(error) === "projectRecoveryCancelled" ? "cancelled" : "failed",
                    safeCode(error)
                );
                return;
            }
            await this.compensate(saved, target, safeCode(error));
        }
    }
}

const worker = new SiteRecoveryWorker();
module.exports = {
    context,
    capability,
    retainedCapability,
    source,
    sameIncident,
    overview,
    createPlan,
    approve,
    cancel,
    rollback,
    reset,
    publicJob,
    worker,
    SiteRecoveryWorker,
    openStatuses,
    notify,
};
