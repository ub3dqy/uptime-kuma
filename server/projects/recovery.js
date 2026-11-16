const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { R } = require("redbean-node");
const { permit, id, problem, audit } = require("./access");
const { getVault } = require("./vault");
const files = require("./recovery-files");
const { currentServiceState, observationTime, issueExplanation } = require("../../src/overview-state.ts");
const { parentIsInactive } = require("./store");
const openStatuses = ["queued", "preparing", "applying", "verifying", "reverting", "verifying_rollback", "recovering"];
const terminalStatuses = [
    "succeeded",
    "rolled_back",
    "rollback_unverified",
    "rollback_failed",
    "conflict",
    "cancelled",
    "failed",
];
const monitorKeys = [
    "id",
    "user_id",
    "type",
    "url",
    "method",
    "interval",
    "retry_interval",
    "maxretries",
    "timeout",
    "maxredirects",
    "active",
    "parent",
    "ignore_tls",
    "upside_down",
    "accepted_statuscodes_json",
    "max_response_time",
    "conditions",
    "headers",
    "body",
    "auth_method",
    "basic_auth_user",
    "basic_auth_pass",
    "bearer_token",
    "oauth_client_id",
    "oauth_client_secret",
    "oauth_auth_method",
    "oauth_token_url",
    "oauth_scopes",
    "oauth_audience",
    "auth_domain",
    "auth_workstation",
    "ip_family",
    "tls_ca",
    "tls_cert",
    "tls_key",
    "http_body_encoding",
    "cache_bust",
    "proxy_id",
];
const fingerprint = (monitor) => files.digest(JSON.stringify(monitorKeys.map((key) => [key, monitor[key] ?? null])));
const safeCode = (error) =>
    /^projectRecovery[A-Z][a-zA-Z]+$/.test(error?.message) ? error.message : "projectRecoveryUnavailable";

/**
 * @param {number} userID Human
 * @param {number} projectID Scope
 * @param {object} db Connection
 * @returns {Promise<object>} Project owner with administrator rights
 */
async function owner(userID, projectID, db = R.knex) {
    const scope = await permit(userID, projectID, "admin", db);
    if (scope.owner_id !== userID) {
        throw problem("projectRecoveryOwnerOnly");
    }
    return scope;
}

/**
 * @param {number} userID Owner
 * @param {number} projectID Scope
 * @param {string} password Fresh password, never retained
 * @returns {Promise<void>} Actual owner reauthentication
 */
async function proof(userID, projectID, password) {
    await owner(userID, projectID);
    if (!(await require("../rate-limiter").loginRateLimiter.pass(null))) {
        throw problem("projectRecoveryRateLimit");
    }
    const auth = require("../auth");
    const human = await auth.findHumanByID(userID);
    if (
        typeof password !== "string" ||
        password.length > 1024 ||
        !human ||
        !require("../password-hash").verify(password, auth.passwordFor(human))
    ) {
        throw problem("projectRecoveryPassword");
    }
}

/**
 * @param {object} scope Current project
 * @param {number} monitorID Check
 * @param {string} targetID Fixed recipe
 * @param {object} db Connection
 * @returns {Promise<object>} Current exact managed check and recipe
 */
async function context(scope, monitorID, targetID, db = R.knex) {
    const target = files
        .profiles()
        .find((item) => item.id === targetID && item.projectID === scope.id && item.monitorID === monitorID);
    const monitor = await db("monitor")
        .where({ id: id(monitorID), user_id: scope.data_user_id })
        .first();
    if (
        !target ||
        scope.personal ||
        !monitor ||
        monitor.type !== "http" ||
        monitor.url !== target.checkURL ||
        (monitor.method || "GET") !== "GET" ||
        monitor.ignore_tls ||
        monitor.upside_down ||
        monitor.interval < 20 ||
        monitor.interval > 60 ||
        target.verifySeconds < monitor.interval * 2 + 5
    ) {
        throw problem("projectRecoveryNotConfigured");
    }
    if (monitor.parent) {
        const ancestors = await db("monitor").where({ user_id: scope.data_user_id }).select("id", "active", "parent");
        monitor.forceInactive = parentIsInactive(monitor, new Map(ancestors.map((row) => [row.id, row])));
    }
    const beats = await db("heartbeat").where({ monitor_id: monitor.id }).orderBy("id", "desc").limit(4);
    const current = currentServiceState(monitor, [...beats].reverse());
    return { target, monitor, beats, current };
}

/**
 * @param {object} value Exact check context
 * @returns {Promise<void>} Only a current confirmed failure may authorize a forward change
 */
async function requireFailure(value) {
    if (
        value.current.state !== "down" ||
        !value.current.latest?.check_session ||
        value.current.latest.status !== 0 ||
        !value.monitor.active ||
        value.monitor.forceInactive
    ) {
        throw problem("projectRecoveryFailureRequired");
    }
    if (await R.knex.schema.hasTable("monitor_maintenance")) {
        if (await require("../model/monitor").isUnderMaintenance(value.monitor.id)) {
            throw problem("projectRecoveryFailureRequired");
        }
    }
}

/**
 * @param {number} monitorID Exact check
 * @returns {Promise<boolean>} Current maintenance without inventing monitoring evidence
 */
async function underMaintenance(monitorID) {
    return (
        (await R.knex.schema.hasTable("monitor_maintenance")) &&
        (await require("../model/monitor").isUnderMaintenance(monitorID))
    );
}

/**
 * Safe capability facts for the explicit AI preview; no paths, bytes or commands.
 * @param {object} scope Authorized project
 * @param {object} monitor Owned check
 * @param {string} targetID Exact trusted recipe
 * @param {object} db Connection
 * @returns {Promise<object>} Bounded capability
 */
async function capability(scope, monitor, targetID, db = R.knex) {
    const value = await context(scope, monitor.id, targetID, db);
    if (value.current.state !== "down" || !value.current.latest?.check_session) {
        throw problem("projectRecoveryFailureRequired");
    }
    const checked = files.inspect(value.target);
    return {
        targetID: value.target.id,
        scenario: "restore_config",
        policyFingerprint: value.target.fingerprint,
        monitorFingerprint: fingerprint(monitor),
        currentHash: checked.before.hash,
        approvedHash: checked.baseline.hash,
        verifiedOwnerBaseline: false,
        limitations: [
            "The installation owner approved these JSON bytes. Their ability to fix this incident is unproven until two new monitoring observations succeed. No file contents were shared. Owner approval is still required; recommend none when evidence is insufficient.",
        ],
    };
}

/**
 * @param {object} row Retained action
 * @returns {object} Secret-free state
 */
function publicJob(row) {
    const plan = JSON.parse(row.plan_json);
    return {
        id: row.id,
        aiJobID: row.ai_job_id,
        monitorID: row.monitor_id,
        targetID: row.target_id,
        status: row.status,
        revision: row.revision,
        planHash: row.plan_hash,
        title: plan.title,
        beforeHash: plan.beforeHash,
        afterHash: plan.afterHash,
        reload: plan.reload,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
        approvedAt: row.approved_at === null ? null : Number(row.approved_at),
        snapshotAt: row.snapshot_at === null ? null : Number(row.snapshot_at),
        appliedAt: row.applied_at === null ? null : Number(row.applied_at),
        rollbackAt: row.rollback_at === null ? null : Number(row.rollback_at),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at),
        cancelRequested: Boolean(row.cancel_requested),
        errorCode: row.error_code,
        verification: row.verification_json ? JSON.parse(row.verification_json) : null,
        rollbackVerification: row.rollback_verification_json ? JSON.parse(row.rollback_verification_json) : null,
        canRollback:
            ["succeeded", "rollback_unverified", "rollback_failed", "conflict"].includes(row.status) &&
            Boolean(row.snapshot_cipher),
    };
}

/**
 * @param {number} userID Actor
 * @param {number} projectID Scope
 * @returns {Promise<object>} Authorized visible state, never private descriptors
 */
async function overview(userID, projectID) {
    const scope = await permit(userID, projectID);
    let targets = [];
    let configurationError = false;
    try {
        if (!worker.ready && process.env.UPTIME_KUMA_RECOVERY_MANIFEST) {
            await worker.start();
        }
        if (worker.ready) {
            try {
                worker.ownsLock();
            } catch {
                /* Executor availability is reported below. */
            }
        }
        targets = files
            .profiles()
            .filter((item) => item.projectID === projectID)
            .map(({ id, monitorID, title, reload, verifySeconds }) => ({
                id,
                monitorID,
                title,
                reload: reload.kind,
                verifySeconds,
            }));
    } catch {
        configurationError = true;
    }
    const rows = await R.knex("project_recovery").where({ project_id: projectID }).orderBy("id", "desc").limit(30);
    const breakers = await R.knex("project_recovery_target")
        .where({ project_id: projectID })
        .whereNotNull("blocked_at")
        .select("target_id", "reason", "blocked_at");
    await permit(userID, projectID);
    return {
        targets,
        jobs: rows.map(publicJob),
        breakers,
        isOwner: scope.owner_id === userID && scope.role === "admin",
        configured: targets.length > 0,
        configurationError,
        executorReady: worker.ready,
    };
}

/**
 * @param {object} scope Project
 * @param {number} aiJobID Completed model proposal
 * @param {object} db Connection
 * @returns {Promise<object>} Exact AI proposal still bound to its check and policy
 */
async function source(scope, aiJobID, db = R.knex) {
    const job = await db("project_ai_job")
        .where({ id: id(aiJobID), project_id: scope.id, kind: "recovery", status: "completed" })
        .first();
    const ai = await db("project_ai").where({ project_id: scope.id, state: "verified" }).first();
    if (
        !job ||
        !ai ||
        ai.revision !== job.revision ||
        scope.revision !== job.project_revision ||
        job.updated_at < Date.now() - 900000
    ) {
        throw problem("projectRecoveryStale");
    }
    const evidence = JSON.parse(job.input_json);
    const result = JSON.parse(job.result_json);
    if (result.remediation?.action !== "restore_config" || !evidence.recovery || evidence.state !== "down") {
        throw problem("projectRecoveryNoRecommendation");
    }
    return { job, evidence };
}

/**
 * @param {object} value Fresh context
 * @param {object} evidence Consented facts
 * @returns {Promise<void>} Same continuous incident, no intervening success or changed scenario
 */
async function sameIncident(value, evidence) {
    await requireFailure(value);
    if (
        fingerprint(value.monitor) !== evidence.recovery.monitorFingerprint ||
        value.target.fingerprint !== evidence.recovery.policyFingerprint ||
        issueExplanation("down", value.current.latest.msg) !== evidence.reason
    ) {
        throw problem("projectRecoveryStale");
    }
    const originTime = observationTime(evidence.latest?.time);
    const candidates = await R.knex("heartbeat")
        .where({ monitor_id: value.monitor.id, status: 0 })
        .where("id", "<=", value.current.latest.id)
        .orderBy("id", "desc")
        .limit(1000);
    const origin = candidates.find((beat) => observationTime(beat.time) === originTime);
    if (!origin?.check_session || value.current.latest.check_session !== origin.check_session) {
        throw problem("projectRecoveryStale");
    }
    const intervening = await R.knex("heartbeat")
        .where({ monitor_id: value.monitor.id })
        .where("id", ">", origin.id)
        .whereNot("status", 0)
        .first();
    if (intervening) {
        throw problem("projectRecoveryStale");
    }
}

/**
 * @param {number} userID Operator
 * @param {object} request AI proposal identifier
 * @param {Function} guard Current login
 * @returns {Promise<object>} Concrete reviewable plan, no change yet
 */
async function createPlan(userID, request, guard) {
    const scope = await permit(userID, id(request.projectID), "operator");
    const { job, evidence } = await source(scope, request.aiJobID);
    const value = await context(scope, job.monitor_id, evidence.recovery.targetID);
    await sameIncident(value, evidence);
    const checked = files.inspect(value.target);
    if (
        checked.before.hash !== evidence.recovery.currentHash ||
        checked.baseline.hash !== evidence.recovery.approvedHash
    ) {
        throw problem("projectRecoveryDrift");
    }
    const unitState = await files.service(value.target);
    const plan = {
        targetFingerprint: value.target.fingerprint,
        monitorFingerprint: fingerprint(value.monitor),
        beforeHash: checked.before.hash,
        afterHash: checked.baseline.hash,
        mode: checked.before.mode,
        uid: checked.before.uid,
        gid: checked.before.gid,
        title: value.target.title,
        reload: value.target.reload.kind,
        unitState,
    };
    const planHash = files.digest(
        JSON.stringify({ projectID: scope.id, aiJobID: job.id, ownerID: scope.owner_id, ...plan })
    );
    const recoveryID = await R.knex.transaction(async (tx) => {
        await guard(tx);
        const current = await permit(userID, scope.id, "operator", tx);
        if (current.revision !== scope.revision) {
            throw problem("projectRecoveryStale");
        }
        const existing = await tx("project_recovery").where({ ai_job_id: job.id }).first();
        if (existing) {
            return existing.id;
        }
        await tx("project_recovery_target")
            .insert({ project_id: scope.id, target_id: value.target.id })
            .onConflict(["project_id", "target_id"])
            .ignore();
        const target = await tx("project_recovery_target")
            .where({ project_id: scope.id, target_id: value.target.id })
            .first();
        if (target.open_id || target.blocked_at) {
            throw problem("projectRecoveryBlocked");
        }
        const [savedID] = await tx("project_recovery").insert({
            project_id: scope.id,
            monitor_id: job.monitor_id,
            ai_job_id: job.id,
            proposed_by: userID,
            target_id: value.target.id,
            project_revision: scope.revision,
            ai_revision: job.revision,
            plan_hash: planHash,
            plan_json: JSON.stringify(plan),
            created_at: Date.now(),
            updated_at: Date.now(),
            expires_at: Date.now() + 300000,
        });
        await tx("project_recovery_target")
            .where({ project_id: scope.id, target_id: value.target.id })
            .update({ open_id: savedID });
        await audit(tx, current, "recoveryPlanned", savedID);
        await guard(tx);
        return savedID;
    });
    return publicJob(await R.knex("project_recovery").where({ id: recoveryID }).first());
}

/**
 * @param {number} userID Owner
 * @param {object} request Exact plan, revision, explicit consent and fresh password
 * @param {Function} guard Live login
 * @returns {Promise<object>} Idempotently queued approved action
 */
async function approve(userID, request, guard) {
    const scope = await owner(userID, id(request.projectID));
    await proof(userID, scope.id, request.password);
    if (request.confirm !== true || !worker.ready) {
        throw problem("projectRecoveryExecutor");
    }
    worker.ownsLock();
    const row = await R.knex("project_recovery")
        .where({ id: id(request.id), project_id: scope.id })
        .first();
    if (!row || row.plan_hash !== request.planHash) {
        throw problem("projectRecoveryStale");
    }
    if (row.approved_at) {
        return publicJob(row);
    }
    const { job, evidence } = await source(scope, row.ai_job_id);
    const value = await context(scope, job.monitor_id, row.target_id);
    await sameIncident(value, evidence);
    const checked = files.inspect(value.target);
    const plan = JSON.parse(row.plan_json);
    if (
        checked.before.hash !== plan.beforeHash ||
        checked.baseline.hash !== plan.afterHash ||
        (await files.service(value.target)) !== plan.unitState
    ) {
        throw problem("projectRecoveryDrift");
    }
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const current = await owner(userID, scope.id, tx);
        const saved = await tx("project_recovery").where({ id: row.id }).first();
        if (saved.approved_at) {
            return;
        }
        if (
            saved.status !== "planned" ||
            saved.revision !== request.revision ||
            saved.expires_at <= Date.now() ||
            current.revision !== row.project_revision
        ) {
            throw problem("projectRecoveryStale");
        }
        const target = await tx("project_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .first();
        if (target.blocked_at || target.open_id !== row.id) {
            throw problem("projectRecoveryBlocked");
        }
        const attempts = await tx("project_recovery")
            .where({ project_id: scope.id, target_id: row.target_id })
            .where("approved_at", ">", Date.now() - 86400000)
            .select("approved_at");
        if (attempts.length >= 3 || attempts.some((entry) => entry.approved_at > Date.now() - 300000)) {
            throw problem("projectRecoveryRateLimit");
        }
        const queued = await tx("project_recovery").whereIn("status", openStatuses).count({ n: "id" }).first();
        if (Number(queued.n) >= 20) {
            throw problem("projectRecoveryBlocked");
        }
        await tx("project_recovery")
            .where({ id: row.id, status: "planned" })
            .update({
                approved_by: userID,
                approved_at: Date.now(),
                status: "queued",
                revision: saved.revision + 1,
                updated_at: Date.now(),
            });
        await audit(tx, current, "recoveryApproved", row.id);
        await guard(tx);
    });
    return publicJob(await R.knex("project_recovery").where({ id: row.id }).first());
}

/**
 * @param {number} userID Owner
 * @param {object} request Current action
 * @param {Function} guard Login
 * @returns {Promise<void>} Cancellation, with compensation if change already began
 */
async function cancel(userID, request, guard) {
    await R.knex.transaction(async (tx) => {
        const scope = await owner(userID, id(request.projectID), tx);
        const row = await tx("project_recovery")
            .where({ id: id(request.id), project_id: scope.id })
            .first();
        if (!row || row.revision !== request.revision) {
            throw problem("projectRecoveryStale");
        }
        if (row.status === "planned") {
            await tx("project_recovery")
                .where({ id: row.id })
                .update({
                    status: "cancelled",
                    finished_at: Date.now(),
                    updated_at: Date.now(),
                    revision: row.revision + 1,
                });
            await tx("project_recovery_target").where({ open_id: row.id }).update({ open_id: null });
        } else if (openStatuses.includes(row.status)) {
            await tx("project_recovery")
                .where({ id: row.id })
                .update({ cancel_requested: 1, revision: row.revision + 1, updated_at: Date.now() });
        }
        await audit(tx, scope, "recoveryCancelled", row.id);
        await guard(tx);
    });
}

/**
 * @param {number} userID Owner
 * @param {object} request Exact completed change and password
 * @param {Function} guard Live identity
 * @returns {Promise<void>} One scoped rollback, never another forward action
 */
async function rollback(userID, request, guard) {
    await proof(userID, id(request.projectID), request.password);
    if (!worker.ready || request.confirm !== true) {
        throw problem("projectRecoveryExecutor");
    }
    await R.knex.transaction(async (tx) => {
        const scope = await owner(userID, request.projectID, tx);
        const row = await tx("project_recovery")
            .where({ id: id(request.id), project_id: scope.id })
            .first();
        if (!row || row.plan_hash !== request.planHash || !row.snapshot_cipher) {
            throw problem("projectRecoveryStale");
        }
        if (["reverting", "verifying_rollback", "rolled_back"].includes(row.status)) {
            return;
        }
        if (
            !["succeeded", "rollback_unverified", "rollback_failed", "conflict"].includes(row.status) ||
            row.revision !== request.revision
        ) {
            throw problem("projectRecoveryStale");
        }
        const target = await tx("project_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .first();
        if (target.open_id) {
            throw problem("projectRecoveryBlocked");
        }
        await tx("project_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .update({ open_id: row.id });
        await tx("project_recovery")
            .where({ id: row.id })
            .update({
                status: "reverting",
                cancel_requested: 1,
                reload_phase: null,
                revision: row.revision + 1,
                updated_at: Date.now(),
            });
        await audit(tx, scope, "recoveryRollbackRequested", row.id);
        await guard(tx);
    });
}

/**
 * @param {number} userID Owner
 * @param {object} request Fixed target and password
 * @param {Function} guard Live identity
 * @returns {Promise<void>} Acknowledge failure before a later new proposal; rate limits remain
 */
async function reset(userID, request, guard) {
    if (typeof request.targetID !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(request.targetID)) {
        throw problem("projectRecoveryNotConfigured");
    }
    await proof(userID, id(request.projectID), request.password);
    await R.knex.transaction(async (tx) => {
        const scope = await owner(userID, request.projectID, tx);
        const row = await tx("project_recovery_target")
            .where({ project_id: scope.id, target_id: request.targetID })
            .first();
        if (!row || row.open_id) {
            throw problem("projectRecoveryBlocked");
        }
        await tx("project_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .update({ blocked_at: null, reason: null });
        await audit(tx, scope, "recoveryBlockCleared", row.target_id);
        await guard(tx);
    });
}

/** One local process, one in-flight filesystem change; crash recovery only compensates. */
class RecoveryWorker {
    /** @param {object} options Test-owned service dependency and clock */
    constructor(options = {}) {
        this.service = options.service || files.service;
        this.now = options.now || Date.now;
        this.ready = false;
    }
    /** @returns {Promise<void>} Acquire exclusive local process lock before recovering any writes */
    async start() {
        if (this.ready || this.starting || this.lockLost) {
            return;
        }
        this.starting = true;
        try {
            this.stopped = false;
            this.ownerToken = randomUUID();
            if (!files.profiles().length) {
                return;
            }
            this.filename = path.join(path.dirname(getVault().filename), "recovery-worker.lock");
            if (fs.existsSync(this.filename)) {
                files.noLinks(this.filename);
                const old = JSON.parse(fs.readFileSync(this.filename, "utf8"));
                if (old.host !== os.hostname() || !Number.isSafeInteger(old.pid) || old.pid < 1) {
                    return;
                }
                try {
                    process.kill(old.pid, 0);
                    return;
                } catch (error) {
                    if (error.code !== "ESRCH") {
                        return;
                    }
                }
                fs.unlinkSync(this.filename);
            }
            const handle = fs.openSync(this.filename, "wx", 0o600);
            try {
                fs.writeFileSync(
                    handle,
                    JSON.stringify({ host: os.hostname(), pid: process.pid, token: this.ownerToken })
                );
                fs.fsyncSync(handle);
            } finally {
                fs.closeSync(handle);
            }
            this.ready = true;
            await R.knex("project_recovery")
                .whereIn("status", ["preparing", "applying", "verifying", "reverting", "verifying_rollback"])
                .update({ status: "recovering", error_code: "projectRecoveryInterrupted", updated_at: this.now() });
            this.timer = setInterval(() => this.tick(), 1000);
            this.timer.unref();
        } finally {
            this.starting = false;
        }
    }
    /**
     * @returns {void} Ensure this exact process still holds its lock
     * @throws {Error} This process lost its exclusive lock
     */
    ownsLock() {
        try {
            if (
                !this.ready ||
                !this.filename ||
                JSON.parse(fs.readFileSync(this.filename, "utf8")).token !== this.ownerToken
            ) {
                throw new Error("Lost local executor lock");
            }
        } catch {
            this.ready = false;
            this.lockLost = true;
            throw problem("projectRecoveryExecutor");
        }
    }
    /** @returns {Promise<void>} Finish compensation before releasing our exact lock */
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        try {
            await this.task;
        } finally {
            if (this.ready && fs.existsSync(this.filename)) {
                // Do not remove another process's replacement lock during shutdown.
                try {
                    this.ownsLock();
                    fs.unlinkSync(this.filename);
                } catch {
                    /* Leave the retained lock for owner review. */
                }
            }
            this.ready = false;
        }
    }
    /** @returns {Promise<void>} Expire drafts and claim at most one action */
    async tick() {
        if (!this.ready || this.stopped || this.task || this.claiming) {
            return;
        }
        this.claiming = true;
        try {
            this.ownsLock();
            const expired = await R.knex("project_recovery")
                .where({ status: "planned" })
                .where("expires_at", "<=", this.now());
            for (const row of expired) {
                await this.finish(row, "cancelled", "projectRecoveryStale");
            }
            const row = await R.knex("project_recovery")
                .whereIn("status", ["queued", "reverting", "recovering"])
                .orderBy("id")
                .first();
            if (row) {
                const task = this.run(row)
                    .catch(() => {})
                    .finally(() => {
                        this.task = null;
                    });
                this.task = task;
            }
        } catch {
            // A lock/database failure never authorizes a filesystem operation.
        } finally {
            this.claiming = false;
        }
    }
    /**
     * @param {object} row Job
     * @param {string} status Next state
     * @param {object} extra Fixed persistence values
     * @returns {Promise<void>} Persist before any following side effect
     */
    async transition(row, status, extra = {}) {
        this.ownsLock();
        await R.knex("project_recovery")
            .where({ id: row.id })
            .update({ ...extra, status, updated_at: this.now(), revision: R.knex.raw("revision + 1") });
    }
    /**
     * @param {object} row Job
     * @param {string} status Terminal state
     * @param {string|null} code Fixed failure
     * @returns {Promise<void>} Release scope, retain recovery point, block repeats on adverse outcome
     */
    async finish(row, status, code = null) {
        this.ownsLock();
        await R.knex.transaction(async (tx) => {
            await tx("project_recovery")
                .where({ id: row.id })
                .update({
                    status,
                    error_code: code,
                    finished_at: this.now(),
                    updated_at: this.now(),
                    revision: tx.raw("revision + 1"),
                });
            const blocked = !["succeeded", "cancelled"].includes(status);
            await tx("project_recovery_target")
                .where({ project_id: row.project_id, target_id: row.target_id, open_id: row.id })
                .update({
                    open_id: null,
                    ...(blocked ? { blocked_at: this.now(), reason: code || "projectRecoveryRepeatedFailure" } : {}),
                });
            await audit(
                tx,
                { id: row.project_id, actor_id: row.approved_by || row.proposed_by },
                "recoveryFinished",
                row.id
            );
        });
    }
    /**
     * @param {object} row Approved job
     * @returns {Promise<object>} Fresh forward authority and exact incident
     */
    async forward(row) {
        this.ownsLock();
        if (this.stopped) {
            throw problem("projectRecoveryCancelled");
        }
        const saved = await R.knex("project_recovery").where({ id: row.id }).first();
        if (saved.cancel_requested || !saved.approved_by || !openStatuses.includes(saved.status)) {
            throw problem("projectRecoveryCancelled");
        }
        if (saved.expires_at <= Date.now()) {
            throw problem("projectRecoveryStale");
        }
        const scope = await owner(saved.approved_by, saved.project_id);
        const { evidence } = await source(scope, saved.ai_job_id);
        const value = await context(scope, saved.monitor_id, saved.target_id);
        await sameIncident(value, evidence);
        return value;
    }
    /**
     * Recheck authority for the separate service operation after the file replacement.
     * @param {object} row Approved action
     * @returns {Promise<void>} Same owner, recipe and check; a newly healthy response is allowed
     */
    async beforeReload(row) {
        this.ownsLock();
        const saved = await R.knex("project_recovery").where({ id: row.id }).first();
        const scope = await owner(row.approved_by, row.project_id);
        const value = await context(scope, row.monitor_id, row.target_id);
        const plan = JSON.parse(row.plan_json);
        if (
            this.stopped ||
            saved.cancel_requested ||
            scope.revision !== row.project_revision ||
            value.target.fingerprint !== plan.targetFingerprint ||
            fingerprint(value.monitor) !== plan.monitorFingerprint ||
            !value.monitor.active ||
            value.monitor.forceInactive ||
            (await underMaintenance(row.monitor_id))
        ) {
            throw problem("projectRecoveryCancelled");
        }
        if (files.readFile(value.target.file).hash !== plan.afterHash) {
            throw problem("projectRecoveryDrift");
        }
    }
    /**
     * @param {object} row Job
     * @param {number} since Mutation wall time
     * @param {number} previousID Last prior observation
     * @param {object} target Trusted target
     * @param {boolean} rollbackMode Observe restoration even if it remains unhealthy
     * @returns {Promise<object|null>} Two real successes, or one real rollback observation
     */
    async observe(row, since, previousID, target, rollbackMode = false) {
        const deadline = this.now() + target.verifySeconds * 1000;
        for (;;) {
            this.ownsLock();
            if (this.stopped && rollbackMode) {
                return null;
            }
            const saved = await R.knex("project_recovery").where({ id: row.id }).first();
            const monitor = await R.knex("monitor").where({ id: row.monitor_id }).first();
            const plan = JSON.parse(row.plan_json);
            if (
                !monitor ||
                fingerprint(monitor) !== plan.monitorFingerprint ||
                !monitor.active ||
                (saved.cancel_requested && !rollbackMode) ||
                (this.stopped && !rollbackMode)
            ) {
                throw problem("projectRecoveryCancelled");
            }
            if (!rollbackMode) {
                await owner(row.approved_by, row.project_id);
                if (files.readFile(target.file).hash !== plan.afterHash) {
                    throw problem("projectRecoveryDrift");
                }
            }
            const beats = await R.knex("heartbeat")
                .where({ monitor_id: row.monitor_id })
                .where("id", ">", previousID)
                .orderBy("id", "desc")
                .limit(4);
            const fresh = beats.filter((beat) => {
                const time = observationTime(beat.time);
                return (
                    time !== null &&
                    time >= since &&
                    time <= this.now() &&
                    this.now() - time <= Math.max(30000, monitor.interval * 2500) &&
                    beat.check_session
                );
            });
            const candidates = rollbackMode ? fresh.slice(0, 1) : fresh.slice(0, 2);
            if (
                candidates.length === (rollbackMode ? 1 : 2) &&
                (rollbackMode ||
                    candidates.every((beat) => beat.status === 1 && beat.check_session === candidates[0].check_session))
            ) {
                return {
                    observedAt: this.now(),
                    healthy: candidates.every((beat) => beat.status === 1),
                    observations: candidates.map(({ id, time, status, check_session: session }) => ({
                        id,
                        time,
                        status,
                        session,
                    })),
                };
            }
            if (this.now() >= deadline) {
                return null;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    /**
     * @param {object} row Approved job with durable point
     * @param {string} reason Fixed cause for compensation
     * @returns {Promise<void>} Restore only the bytes this operation replaced
     */
    async compensate(row, reason) {
        this.ownsLock();
        const saved = await R.knex("project_recovery").where({ id: row.id }).first();
        if (!saved.snapshot_cipher || !saved.approved_by) {
            await this.finish(saved, "failed", reason);
            return;
        }
        let restored = false;
        try {
            const snapshot = getVault().open(saved.project_id, saved.snapshot_cipher, "recovery");
            const plan = JSON.parse(saved.plan_json);
            if (
                snapshot.planHash !== saved.plan_hash ||
                snapshot.target.projectID !== saved.project_id ||
                snapshot.target.monitorID !== saved.monitor_id ||
                snapshot.target.id !== saved.target_id
            ) {
                throw problem("projectRecoveryDrift");
            }
            const bytes = Buffer.from(snapshot.bytes, "base64");
            if (files.digest(bytes) !== plan.beforeHash) {
                throw problem("projectRecoveryBackup");
            }
            files.confined(snapshot.target.root, snapshot.target.file);
            const actual = files.readFile(snapshot.target.file);
            if (![plan.afterHash, plan.beforeHash].includes(actual.hash)) {
                await this.finish(saved, "conflict", "projectRecoveryDrift");
                return;
            }
            if (actual.hash === plan.beforeHash && !saved.reload_phase && !saved.applied_at) {
                await this.finish(saved, reason === "projectRecoveryCancelled" ? "cancelled" : "failed", reason);
                return;
            }
            await this.transition(saved, "reverting", { error_code: reason });
            if (actual.hash !== plan.beforeHash) {
                await files.replace(snapshot.target, plan.afterHash, bytes, snapshot.metadata, async () =>
                    this.ownsLock()
                );
            }
            if (saved.reload_phase === "rollback_started" && snapshot.target.reload.kind !== "live") {
                await this.finish(saved, "rollback_unverified", "projectRecoveryInterrupted");
                return;
            }
            let state;
            if (saved.reload_phase === "rollback_done") {
                state = await this.service(snapshot.target);
            } else {
                await R.knex("project_recovery").where({ id: row.id }).update({ reload_phase: "rollback_started" });
                state = await this.service(snapshot.target, "rollback", snapshot.unitState);
                await R.knex("project_recovery").where({ id: row.id }).update({ reload_phase: "rollback_done" });
            }
            if (snapshot.unitState !== "live" && (state === "active") !== (snapshot.unitState === "active")) {
                throw problem("projectRecoveryService");
            }
            if (files.readFile(snapshot.target.file).hash !== plan.beforeHash) {
                throw problem("projectRecoveryDrift");
            }
            restored = true;
            const last = await R.knex("heartbeat")
                .where({ monitor_id: saved.monitor_id })
                .orderBy("id", "desc")
                .first();
            const at = this.now();
            await this.transition(saved, "verifying_rollback", { rollback_at: at });
            const observed = await this.observe(saved, at, last?.id || 0, snapshot.target, true);
            await R.knex("project_recovery")
                .where({ id: saved.id })
                .update({ rollback_verification_json: observed ? JSON.stringify(observed) : null });
            await this.finish(
                saved,
                observed ? "rolled_back" : "rollback_unverified",
                observed ? reason : "projectRecoveryNoObservations"
            );
        } catch (error) {
            await this.finish(
                saved,
                safeCode(error) === "projectRecoveryDrift"
                    ? "conflict"
                    : restored
                      ? "rollback_unverified"
                      : "rollback_failed",
                safeCode(error)
            );
        }
    }
    /**
     * @param {object} row Claimed one-shot job
     * @returns {Promise<void>} Forward once; on interruption or failure compensate without model instructions
     */
    async run(row) {
        if (["reverting", "recovering"].includes(row.status)) {
            await this.compensate(row, row.error_code || "projectRecoveryCancelled");
            return;
        }
        try {
            const claimed = await R.knex("project_recovery")
                .where({ id: row.id, status: "queued" })
                .update({
                    status: "preparing",
                    started_at: this.now(),
                    updated_at: this.now(),
                    revision: R.knex.raw("revision + 1"),
                });
            if (!claimed) {
                return;
            }
            const value = await this.forward(row);
            const plan = JSON.parse(row.plan_json);
            const checked = files.inspect(value.target);
            const unitState = await this.service(value.target);
            if (
                checked.before.hash !== plan.beforeHash ||
                checked.baseline.hash !== plan.afterHash ||
                unitState !== plan.unitState
            ) {
                throw problem("projectRecoveryDrift");
            }
            const metadata = { mode: checked.before.mode, uid: checked.before.uid, gid: checked.before.gid };
            const snapshot = {
                planHash: row.plan_hash,
                target: value.target,
                metadata,
                unitState,
                bytes: checked.before.bytes.toString("base64"),
            };
            const cipher = getVault().seal(row.project_id, snapshot, "recovery");
            if (
                files.digest(Buffer.from(getVault().open(row.project_id, cipher, "recovery").bytes, "base64")) !==
                plan.beforeHash
            ) {
                throw problem("projectRecoveryBackup");
            }
            await this.transition(row, "applying", { snapshot_cipher: cipher, snapshot_at: this.now() });
            const durable = await R.knex("project_recovery").where({ id: row.id }).first();
            if (
                files.digest(
                    Buffer.from(getVault().open(row.project_id, durable.snapshot_cipher, "recovery").bytes, "base64")
                ) !== plan.beforeHash
            ) {
                throw problem("projectRecoveryBackup");
            }
            await files.replace(value.target, plan.beforeHash, checked.baseline.bytes, metadata, () =>
                this.forward(row)
            );
            await R.knex("project_recovery").where({ id: row.id }).update({ reload_phase: "apply_started" });
            await this.beforeReload(row);
            await this.service(value.target, "apply", unitState);
            await R.knex("project_recovery").where({ id: row.id }).update({ reload_phase: "apply_done" });
            const at = this.now();
            const last = await R.knex("heartbeat").where({ monitor_id: row.monitor_id }).orderBy("id", "desc").first();
            await this.transition(row, "verifying", { applied_at: at });
            const observed = await this.observe(row, at, last?.id || 0, value.target);
            if (!observed) {
                throw problem("projectRecoveryNoObservations");
            }
            const finalScope = await owner(row.approved_by, row.project_id);
            const finalValue = await context(finalScope, row.monitor_id, row.target_id);
            const finalRow = await R.knex("project_recovery").where({ id: row.id }).first();
            if (
                finalRow.cancel_requested ||
                (await underMaintenance(row.monitor_id)) ||
                finalValue.current.state !== "up" ||
                fingerprint(finalValue.monitor) !== plan.monitorFingerprint ||
                finalValue.target.fingerprint !== plan.targetFingerprint ||
                files.readFile(value.target.file).hash !== plan.afterHash
            ) {
                throw problem("projectRecoveryCancelled");
            }
            await R.knex("project_recovery")
                .where({ id: row.id })
                .update({ verification_json: JSON.stringify(observed) });
            await this.finish(row, "succeeded");
        } catch (error) {
            const saved = await R.knex("project_recovery").where({ id: row.id }).first();
            if (saved.snapshot_cipher) {
                await this.compensate(saved, safeCode(error));
            } else {
                await this.finish(
                    saved,
                    safeCode(error) === "projectRecoveryCancelled" ? "cancelled" : "failed",
                    safeCode(error)
                );
            }
        }
    }
}

const worker = new RecoveryWorker();
module.exports = {
    capability,
    overview,
    createPlan,
    approve,
    cancel,
    rollback,
    reset,
    worker,
    RecoveryWorker,
    publicJob,
    fingerprint,
    owner,
    proof,
    underMaintenance,
    requireFailure,
    terminalStatuses,
    openStatuses,
};
