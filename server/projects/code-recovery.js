const { randomBytes } = require("node:crypto");
const { R } = require("redbean-node");
const { permit, id, problem, audit } = require("./access");
const legacy = require("./recovery");
const sites = require("./site-recovery");
const client = require("./site-recovery-client");
const ai = require("./ai-service");
const { getVault } = require("./vault");
const patch = require("./code-patch");
const { observationTime } = require("../../src/overview-state.ts");

const parse = (value) => (value ? JSON.parse(value) : null);
const working = [
    "generating",
    "staging",
    "reviewing",
    "queued",
    "backing_up",
    "applying",
    "verifying",
    "rollback_queued",
    "rolling_back",
    "verifying_rollback",
];
const executing = ["backing_up", "applying", "verifying", "rolling_back", "verifying_rollback"];
const terminal = ["succeeded", "failed", "rejected", "cancelled", "uncertain", "rolled_back", "rollback_unhealthy"];
const safeError = (error) =>
    /^project(?:CodeRecovery|Recovery|AI)[A-Z][A-Za-z]+$/.test(error?.message)
        ? error.message
        : "projectCodeRecoveryUnavailable";
const seal = (projectID, value) => getVault().seal(projectID, value, "code");
const open = (projectID, value) => getVault().open(projectID, value, "code");

/**
 * @param {object} scope Actual owner scope
 * @param {object} request Fixed installed check
 * @param {object} db Connection
 * @returns {Promise<object>} Live eligible owned check
 */
async function context(scope, request, db = R.knex) {
    const value = await sites.context(scope, id(request.monitorID), request.targetID, db);
    if (
        !value.monitor.active ||
        value.monitor.forceInactive ||
        !["up", "down"].includes(value.current.state) ||
        !value.current.latest?.check_session ||
        (await legacy.underMaintenance(value.monitor.id))
    )
        throw problem("projectCodeRecoveryMaintenance");
    return value;
}

/**
 * @param {object} scope Authorized project
 * @param {object} value Primary installed check
 * @returns {Promise<object[]>} All installed checks of this site, including its readiness check
 */
async function siteChecks(scope, value) {
    const origin = new URL(value.target.checkURL).origin;
    const result = [];
    for (const target of client
        .profiles()
        .filter(
            (item) =>
                item.projectID === scope.id &&
                item.ownerID === scope.owner_id &&
                item.brokerID === value.target.brokerID &&
                new URL(item.checkURL).origin === origin
        )) {
        const checked = await context(scope, { monitorID: target.monitorID, targetID: target.id });
        result.push({
            targetID: target.id,
            monitorID: target.monitorID,
            monitorFingerprint: legacy.fingerprint(checked.monitor),
            targetFingerprint: target.fingerprint,
            state: checked.current.state,
        });
    }
    return result.sort((a, b) => a.monitorID - b.monitorID);
}
const checkIdentity = (checks) =>
    checks.map(({ targetID, monitorID, monitorFingerprint, targetFingerprint }) => ({
        targetID,
        monitorID,
        monitorFingerprint,
        targetFingerprint,
    }));

/**
 * @param {object} row Durable row
 * @param {boolean} owner Actual owner only
 * @returns {object} Bounded view without code for other roles
 */
function publicJob(row, owner = false) {
    const plan = parse(row.plan_json);
    const result = {
        id: row.id,
        targetID: row.target_id,
        monitorID: row.monitor_id,
        status: row.status,
        revision: row.revision,
        planHash: row.plan_hash,
        createdAt: Number(row.created_at),
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
        approvedAt: row.approved_at === null ? null : Number(row.approved_at),
        errorCode: row.error_code,
        cancelRequested: Boolean(row.cancel_requested),
        backup: parse(row.backup_json),
        verification: parse(row.verification_json),
        rollback: parse(row.rollback_json),
        canRollback: Boolean(
            (row.applied_json || row.status === "uncertain") &&
            row.backup_json &&
            ["succeeded", "failed", "uncertain"].includes(row.status)
        ),
    };
    if (owner) result.plan = plan;
    return result;
}

/**
 * @param {number} userID Actor
 * @param {number} projectID Project
 * @returns {Promise<object>} Registered targets and retained jobs
 */
async function overview(userID, projectID) {
    const scope = await permit(userID, projectID);
    let targets = [];
    let configurationError = false;
    try {
        targets = client
            .profiles()
            .filter((t) => t.projectID === scope.id && t.ownerID === scope.owner_id)
            .map(({ id, title, monitorID }) => ({ id, title, monitorID }));
        if (targets.length) await worker.start();
    } catch {
        configurationError = true;
    }
    const rows = await R.knex("project_code_recovery").where({ project_id: scope.id }).orderBy("id", "desc").limit(30);
    await permit(userID, projectID);
    return {
        targets,
        configured: targets.length > 0,
        configurationError,
        executorReady: worker.ready,
        isOwner: scope.role === "admin" && scope.owner_id === userID,
        jobs: rows.map((row) => publicJob(row, scope.owner_id === userID)),
        breakers: await R.knex("project_code_recovery_target")
            .where({ project_id: scope.id })
            .whereNotNull("blocked_at")
            .select("target_id"),
    };
}

/**
 * @param {number} userID Actual owner
 * @param {object} request Installed target
 * @returns {Promise<object>} Paths only, no source is shared with AI
 */
async function index(userID, request) {
    const scope = await legacy.owner(userID, id(request.projectID));
    const { target } = await context(scope, request);
    const reply = await client.request(target, "code_index");
    if (
        reply?.ok !== true ||
        reply.targetID !== target.id ||
        !Array.isArray(reply.files) ||
        reply.files.length > 1024 ||
        reply.files.some(
            (f) => !patch.allowedPath(f.path) || !Number.isInteger(f.bytes) || f.bytes < 0 || f.bytes > 4194304
        )
    )
        throw problem("projectCodeRecoveryPolicy");
    await legacy.owner(userID, scope.id);
    return { index: reply };
}

/**
 * @param {number} userID Owner
 * @param {object} request Selected file windows and reproducible problem
 * @returns {Promise<object>} Exact plaintext preview visible only to its owner
 */
async function preview(userID, request) {
    const scope = await legacy.owner(userID, id(request.projectID));
    const connection = await R.knex("project_ai").where({ project_id: scope.id, state: "verified" }).first();
    if (!connection) throw problem("projectAINeedProbe");
    const value = await context(scope, request);
    if (
        typeof request.description !== "string" ||
        request.description.trim().length < 15 ||
        request.description.length > 3000 ||
        typeof request.paths !== "object" ||
        !Array.isArray(request.paths) ||
        request.paths.length < 1 ||
        request.paths.length > 4 ||
        request.paths.some(
            (p) => !patch.allowedPath(p.path) || !Number.isInteger(p.offset) || p.offset < 0 || p.offset > 4194304
        )
    )
        throw problem("projectCodeRecoveryDescription");
    const jobID = randomBytes(16).toString("hex");
    const result = await client.request(value.target, "code_source", { jobID, paths: request.paths });
    const source = result?.source;
    if (
        result?.ok !== true ||
        result.targetID !== value.target.id ||
        source?.targetID !== value.target.id ||
        source.jobID !== jobID ||
        !/^[a-f0-9]{64}$/.test(source.sourceHash) ||
        !["javascript", "python"].includes(source.language) ||
        !Array.isArray(source.files) ||
        source.files.length !== request.paths.length ||
        JSON.stringify(source).length > 85000
    )
        throw problem("projectCodeRecoveryPolicy");
    const evidence = {
        connection: { revision: connection.revision, mode: connection.mode, model: connection.model },
        checks: await siteChecks(scope, value),
        codeRepair: { source, description: request.description.trim() },
        monitorFingerprint: legacy.fingerprint(value.monitor),
        targetFingerprint: value.target.fingerprint,
        origin: {
            state: value.current.state,
            beatID: value.current.latest?.id || null,
            checkSession: value.current.latest?.check_session || null,
            time: observationTime(value.current.latest?.time),
        },
        limitations: [
            "No production credentials, database content or raw logs. Existing code windows only. A separate failing-before/passing-after test and owner approval are required. HTTP availability does not prove every business function.",
        ],
    };
    const token = seal(scope.id, {
        evidence,
        projectRevision: scope.revision,
        aiRevision: connection.revision,
        ownerID: userID,
        monitorID: value.monitor.id,
        targetID: value.target.id,
        at: Date.now(),
    });
    await legacy.owner(userID, scope.id);
    return { evidence, token, hash: patch.hash(JSON.stringify(evidence)) };
}

/**
 * @param {number} userID Owner
 * @param {object} request Consented exact source
 * @param {Function} guard Live identity
 * @returns {Promise<object>} Two durable budget slots, no site modifications
 */
async function generate(userID, request, guard) {
    const projectID = id(request.projectID);
    await legacy.owner(userID, projectID);
    if (request.confirm !== true || typeof request.token !== "string" || request.token.length > 300000)
        throw problem("projectCodeRecoveryConsent");
    const saved = open(projectID, request.token);
    if (
        saved.ownerID !== userID ||
        Date.now() - saved.at > 600000 ||
        saved.at > Date.now() ||
        patch.hash(JSON.stringify(saved.evidence)) !== request.hash
    )
        throw problem("projectRecoveryStale");
    const scope = await legacy.owner(userID, projectID);
    const value = await context(scope, saved);
    if (
        saved.projectRevision !== scope.revision ||
        saved.evidence.monitorFingerprint !== legacy.fingerprint(value.monitor) ||
        saved.evidence.targetFingerprint !== value.target.fingerprint
    )
        throw problem("projectRecoveryDrift");
    if (
        JSON.stringify(checkIdentity(saved.evidence.checks)) !==
        JSON.stringify(checkIdentity(await siteChecks(scope, value)))
    )
        throw problem("projectRecoveryDrift");
    await worker.start();
    if (!worker.ready) throw problem("projectRecoveryExecutor");
    return ai.locked(projectID, () =>
        R.knex.transaction(async (tx) => {
            await guard(tx);
            const current = await legacy.owner(userID, projectID, tx);
            const config = await tx("project_ai").where({ project_id: projectID, state: "verified" }).first();
            if (!config) throw problem("projectAINeedProbe");
            if (config.revision !== saved.aiRevision || current.revision !== saved.projectRevision) throw problem("projectAIEvidenceChanged");
            const day = ai.bucketDay(current.timezone);
            const count = await tx("project_ai_job")
                .where({ project_id: projectID, bucket_day: day })
                .count({ n: "id" })
                .first();
            if (Number(count.n) + 2 > config.daily_limit) throw problem("projectCodeRecoveryBudget");
            if (
                (await tx("project_ai_job")
                    .where({ project_id: projectID })
                    .whereIn("status", ["queued", "running", "held"])
                    .first()) ||
                (await tx("project_code_recovery")
                    .where({ project_id: projectID })
                    .whereIn("status", [...working, "planned"])
                    .first()) ||
                (await tx("project_site_recovery")
                    .where({ project_id: projectID })
                    .whereIn("status", sites.openStatuses)
                    .first())
            )
                throw problem("projectAIBusy");
            const breaker = await tx("project_code_recovery_target")
                .where({ project_id: projectID, target_id: saved.targetID })
                .first();
            if (breaker?.blocked_at || breaker?.open_id) throw problem("projectRecoveryBlocked");
            const base = {
                project_id: projectID,
                user_id: userID,
                monitor_id: saved.monitorID,
                revision: config.revision,
                project_revision: current.revision,
                trigger: "manual",
                bucket_day: day,
                input_json: "{}",
                created_at: Date.now(),
                updated_at: Date.now(),
            };
            const [generationID] = await tx("project_ai_job").insert({
                ...base,
                kind: "code_patch",
                status: "queued",
                code_input_cipher: seal(projectID, saved.evidence),
            });
            const [reviewID] = await tx("project_ai_job").insert({ ...base, kind: "code_review", status: "held" });
            const [jobID] = await tx("project_code_recovery").insert({
                project_id: projectID,
                monitor_id: saved.monitorID,
                target_id: saved.targetID,
                remote_id: saved.evidence.codeRepair.source.jobID,
                generation_id: generationID,
                review_id: reviewID,
                created_by: userID,
                project_revision: current.revision,
                ai_revision: config.revision,
                status: "generating",
                source_hash: saved.evidence.codeRepair.source.sourceHash,
                source_cipher: seal(projectID, saved.evidence),
                created_at: Date.now(),
                updated_at: Date.now(),
                expires_at: Date.now() + 900000,
            });
            await tx("project_code_recovery_target")
                .insert({ project_id: projectID, target_id: saved.targetID, open_id: jobID })
                .onConflict(["project_id", "target_id"])
                .merge({ open_id: jobID });
            await audit(tx, current, "codeRecoverySourceConsented", jobID);
            await guard(tx);
            return { id: jobID };
        })
    );
}

/**
 * @param {number} userID Owner
 * @param {object} request Exact retained job
 * @returns {Promise<object>} Owner-only changes and regression, always rendered as text
 */
async function details(userID, request) {
    const scope = await legacy.owner(userID, id(request.projectID));
    const row = await R.knex("project_code_recovery")
        .where({ id: id(request.id), project_id: scope.id })
        .first();
    if (!row) throw problem("projectRecoveryStale");
    const generation = await R.knex("project_ai_job").where({ id: row.generation_id }).first();
    const review = await R.knex("project_ai_job").where({ id: row.review_id }).first();
    const result = {
        job: publicJob(row, true),
        source: open(scope.id, row.source_cipher).codeRepair.source,
        proposal: generation?.code_result_cipher ? open(scope.id, generation.code_result_cipher) : null,
        review: review?.code_result_cipher ? open(scope.id, review.code_result_cipher) : null,
    };
    await legacy.owner(userID, scope.id);
    return result;
}

/**
 * @param {number} userID Owner
 * @param {object} request Exact plan
 * @param {Function} guard Login
 * @returns {Promise<object>} Once-only queued approval
 */
async function approve(userID, request, guard) {
    const projectID = id(request.projectID);
    await legacy.proof(userID, projectID, request.password);
    if (request.confirm !== true || !worker.ready) throw problem("projectRecoveryExecutor");
    return R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await legacy.owner(userID, projectID, tx);
        const row = await tx("project_code_recovery")
            .where({ id: id(request.id), project_id: projectID })
            .first();
        if (!row || row.plan_hash !== request.planHash) throw problem("projectRecoveryStale");
        if (row.status === "queued" && row.approved_by === userID) return { job: publicJob(row, true) };
        const config = await tx("project_ai")
            .where({ project_id: projectID, revision: row.ai_revision, state: "verified" })
            .first();
        if (
            row.status !== "planned" ||
            row.revision !== request.revision ||
            row.project_revision !== scope.revision ||
            !config ||
            Number(row.expires_at) <= Date.now()
        )
            throw problem("projectRecoveryStale");
        const plan = parse(row.plan_json);
        const target = await tx("project_code_recovery_target")
            .where({ project_id: projectID, target_id: row.target_id, open_id: row.id })
            .first();
        if (!target || target.blocked_at || plan.review.verdict !== "accept") throw problem("projectRecoveryBlocked");
        await tx("project_code_recovery")
            .where({ id: row.id })
            .update({
                status: "queued",
                approved_by: userID,
                approved_at: Date.now(),
                revision: row.revision + 1,
                updated_at: Date.now(),
            });
        await audit(tx, scope, "codeRecoveryOwnerApproved", row.id);
        await guard(tx);
        return { job: publicJob(await tx("project_code_recovery").where({ id: row.id }).first(), true) };
    });
}

/**
 * @param {number} userID Owner
 * @param {object} request Retained job
 * @param {Function} guard Live login
 * @returns {Promise<object>} Cancellation cannot interrupt a half-written site
 */
async function cancel(userID, request, guard) {
    const projectID = id(request.projectID);
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await legacy.owner(userID, projectID, tx);
        const row = await tx("project_code_recovery")
            .where({ id: id(request.id), project_id: projectID })
            .first();
        if (!row || terminal.includes(row.status)) throw problem("projectRecoveryStale");
        await tx("project_code_recovery")
            .where({ id: row.id })
            .update({ cancel_requested: 1, revision: row.revision + 1, updated_at: Date.now() });
        await tx("project_ai_job")
            .whereIn("id", [row.generation_id, row.review_id])
            .whereIn("status", ["queued", "held"])
            .update({ status: "cancelled", error_code: "cancelled", updated_at: Date.now() });
        await audit(tx, scope, "codeRecoveryCancelled", row.id);
    });
    ai.cancelActive(projectID);
    return {};
}

/**
 * @param {number} userID Owner
 * @param {object} request Exact previous installation
 * @param {Function} guard Login
 * @returns {Promise<object>} Queue conservative rollback, never restore a database
 */
async function rollback(userID, request, guard) {
    await legacy.proof(userID, id(request.projectID), request.password);
    if (request.confirm !== true || !worker.ready) throw problem("projectRecoveryExecutor");
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await legacy.owner(userID, request.projectID, tx);
        const row = await tx("project_code_recovery")
            .where({ id: id(request.id), project_id: scope.id })
            .first();
        if (
            !row ||
            !publicJob(row).canRollback ||
            row.plan_hash !== request.planHash ||
            row.revision !== request.revision
        )
            throw problem("projectRecoveryStale");
        const target = await tx("project_code_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .first();
        if (target?.open_id) throw problem("projectRecoveryBlocked");
        await tx("project_code_recovery_target")
            .where({ project_id: scope.id, target_id: row.target_id })
            .update({ open_id: row.id });
        await tx("project_code_recovery")
            .where({ id: row.id })
            .update({ status: "rollback_queued", revision: row.revision + 1, updated_at: Date.now() });
        await audit(tx, scope, "codeRecoveryRollbackRequested", row.id);
        await guard(tx);
    });
    return {};
}

/**
 * @param {number} userID Owner
 * @param {object} request Fixed target
 * @param {Function} guard Login
 * @returns {Promise<object>} Acknowledgement only; cooldown and history survive
 */
async function reset(userID, request, guard) {
    await legacy.proof(userID, id(request.projectID), request.password);
    await R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await legacy.owner(userID, request.projectID, tx);
        const target = await tx("project_code_recovery_target")
            .where({ project_id: scope.id, target_id: request.targetID })
            .first();
        if (!target || target.open_id) throw problem("projectRecoveryBlocked");
        await tx("project_code_recovery_target")
            .where({ project_id: scope.id, target_id: request.targetID })
            .update({ blocked_at: null });
        await audit(tx, scope, "codeRecoveryBlockCleared", request.targetID);
    });
    return {};
}

/**
 * @param {number} userID Owner
 * @param {object} request Retained point
 * @returns {Promise<object>} Canonical-project transfer, no secrets or launch settings
 */
async function exportPatch(userID, request) {
    const value = await details(userID, request);
    if (!value.proposal?.remediation || value.proposal.remediation.action !== "code_patch")
        throw problem("projectRecoveryStale");
    return {
        package: {
            version: 1,
            projectID: request.projectID,
            monitorID: value.job.monitorID,
            sourceVersion: value.source.version,
            serverJobID: value.source.jobID,
            sourceID: value.job.plan?.sourceID,
            sourceHash: value.source.sourceHash,
            planHash: value.job.planHash,
            patch: value.proposal.remediation,
            generatedChanges: value.job.plan?.changes || [],
            qualification: value.job.plan?.qualification,
            review: value.review,
            instructions:
                "Перенесите правку и проверку в основной проект. Для готовых файлов найдите соответствующий исходный код. После проверки нового выпуска снимите отложенное обновление на сервере штатной командой kuma-code-release. Не удаляйте прежнюю версию или резервные копии.",
            expiresAt: null,
        },
    };
}

/** Leased worker; a retained phase never causes a forward side effect to be replayed after interruption. */
class CodeRecoveryWorker extends sites.SiteRecoveryWorker {
    /**
     * @param {object} options Isolated execution dependencies
     */
    constructor(options = {}) {
        super(options);
        this.table = "project_code_recovery";
        this.observationTable = this.table;
    }
    /**
     * @returns {Promise<void>} Persist or validate the next guarded phase
     */
    async start() {
        if (this.token) return;
        await super.start();
    }
    /**
     * @returns {Promise<boolean>} Verified scoped result
     */
    async lease() {
        return R.knex.transaction(async (tx) => {
            await tx("project_code_recovery_worker")
                .insert({ id: 1, token: this.token, lease_until: this.now() + 30000 })
                .onConflict("id")
                .ignore();
            await tx("project_code_recovery_worker")
                .where({ id: 1 })
                .where((q) => q.where({ token: this.token }).orWhere("lease_until", "<", this.now()))
                .update({ token: this.token, lease_until: this.now() + 30000 });
            const saved = await tx("project_code_recovery_worker").where({ id: 1 }).first();
            return (this.ready = saved.token === this.token && Number(saved.lease_until) > this.now());
        });
    }
    /**
     * @returns {Promise<void>} Persist or validate the next guarded phase
     */
    async ownsLease() {
        const row = await R.knex("project_code_recovery_worker").where({ id: 1, token: this.token }).first();
        if (!this.ready || !row || Number(row.lease_until) <= this.now()) {
            this.ready = false;
            throw problem("projectRecoveryExecutor");
        }
    }
    /**
     * @returns {Promise<void>} Persist or validate the next guarded phase
     */
    async stop() {
        if (!this.token) return;
        this.stopped = true;
        try {
            await this.task;
        } finally {
            clearInterval(this.timer);
            this.timer = null;
            await R.knex("project_code_recovery_worker").where({ id: 1, token: this.token }).delete();
            this.ready = false;
            this.token = null;
        }
    }
    /**
     * @returns {Promise<void>} Persist or validate the next guarded phase
     */
    async tick() {
        if (this.renewing || (this.stopped && !this.task)) return;
        this.renewing = true;
        try {
            if (!(await this.lease()) || this.task || this.stopped) return;
            for (const row of await R.knex(this.table)
                .where({ status: "planned" })
                .where((q) => q.where("expires_at", "<=", this.now()).orWhere({ cancel_requested: 1 })))
                await this.finish(row, "cancelled", "projectRecoveryStale");
            const row = await R.knex(this.table).whereIn("status", working).orderBy("id").first();
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
     * @param {object} row Retained code repair
     * @param {string} status Durable action phase
     * @param {object} extra Bound receipt fields
     * @returns {Promise<void>} Persist or validate the next guarded phase
     */
    async transition(row, status, extra = {}) {
        await this.ownsLease();
        await R.knex(this.table)
            .where({ id: row.id })
            .update({ ...extra, status, revision: R.knex.raw("revision + 1"), updated_at: this.now() });
    }
    /**
     * @param {object} row Retained code repair
     * @param {string} status Durable action phase
     * @param {string|null} errorCode Fixed public error
     * @returns {Promise<void>} Persist or validate the next guarded phase
     */
    async finish(row, status, errorCode = null) {
        await this.ownsLease();
        await R.knex.transaction(async (tx) => {
            await tx(this.table)
                .where({ id: row.id })
                .update({
                    status,
                    error_code: errorCode,
                    finished_at: this.now(),
                    updated_at: this.now(),
                    revision: R.knex.raw("revision + 1"),
                });
            await tx("project_ai_job")
                .whereIn("id", [row.generation_id, row.review_id])
                .whereIn("status", ["held", "queued"])
                .update({ status: "cancelled", error_code: "cancelled", updated_at: this.now() });
            await tx("project_code_recovery_target")
                .where({ project_id: row.project_id, target_id: row.target_id, open_id: row.id })
                .update({
                    open_id: null,
                    ...(["failed", "uncertain", "rolled_back", "rollback_unhealthy"].includes(status)
                        ? { blocked_at: this.now() }
                        : {}),
                });
        });
        await notify(row.id);
    }
    /**
     * @param {object} row Retained code repair
     * @returns {Promise<object>} Verified scoped result
     */
    async forward(row) {
        await this.ownsLease();
        const scope = await legacy.owner(row.created_by, row.project_id);
        const saved = await R.knex(this.table).where({ id: row.id }).first();
        const config = await R.knex("project_ai")
            .where({ project_id: row.project_id, revision: row.ai_revision, state: "verified" })
            .first();
        if (
            saved.cancel_requested ||
            scope.revision !== row.project_revision ||
            !config ||
            this.now() > Number(row.expires_at)
        )
            throw problem("projectRecoveryCancelled");
        const evidence = open(row.project_id, row.source_cipher);
        const value = await context(scope, { monitorID: row.monitor_id, targetID: row.target_id });
        if (
            legacy.fingerprint(value.monitor) !== evidence.monitorFingerprint ||
            value.target.fingerprint !== evidence.targetFingerprint
        )
            throw problem("projectRecoveryDrift");
        if (
            JSON.stringify(checkIdentity(evidence.checks)) !==
            JSON.stringify(checkIdentity(await siteChecks(scope, value)))
        )
            throw problem("projectRecoveryDrift");
        if (evidence.origin.state === "down") {
            await legacy.requireFailure(value);
            const original = await R.knex("heartbeat")
                .where({ id: evidence.origin.beatID, monitor_id: row.monitor_id, status: 0 })
                .first();
            if (
                !original ||
                original.check_session !== evidence.origin.checkSession ||
                observationTime(original.time) !== evidence.origin.time ||
                evidence.origin.checkSession !== value.current.latest?.check_session ||
                (await R.knex("heartbeat")
                    .where({ monitor_id: row.monitor_id })
                    .where("id", ">", evidence.origin.beatID)
                    .whereNot({ status: 0 })
                    .first())
            )
                throw problem("projectRecoveryStale");
        }
        return { ...value, evidence };
    }
    /**
     * @param {object} row Retained code repair
     * @returns {object} Verified scoped result
     */
    args(row) {
        const plan = parse(row.plan_json);
        return {
            jobID: row.remote_id,
            sourceHash: row.source_hash,
            planHash: row.plan_hash,
            patchHash: plan.patchHash,
            qualificationHash: plan.qualificationHash,
            approvedAt: Number(row.approved_at),
        };
    }
    /**
     * @param {object} row Approved code repair
     * @param {object} target Primary installed check
     * @param {number} at After installation or rollback
     * @param {number} lastID Primary observation cursor
     * @param {boolean} rollback Whether this verifies compensation
     * @returns {Promise<object>} Two fresh successes for every installed address of the site
     */
    async observe(row, target, at, lastID, rollback = false) {
        const plan = parse(row.plan_json);
        const checks = plan.checks || [
            {
                targetID: target.id,
                monitorID: row.monitor_id,
                monitorFingerprint: plan.monitorFingerprint,
                targetFingerprint: plan.targetFingerprint,
            },
        ];
        const results = await Promise.allSettled(
            checks.map(async (check) => {
                const profile = client
                    .profiles()
                    .find(
                        (item) =>
                            item.id === check.targetID &&
                            item.projectID === row.project_id &&
                            item.fingerprint === check.targetFingerprint
                    );
                if (!profile) throw problem("projectRecoveryDrift");
                const recent = await R.knex("heartbeat")
                    .where({ monitor_id: check.monitorID })
                    .orderBy("id", "desc")
                    .limit(8);
                const cursor = recent.find((beat) => observationTime(beat.time) < at)?.id || 0;
                const observed = await super.observe(
                    {
                        ...row,
                        monitor_id: check.monitorID,
                        target_id: check.targetID,
                        plan_json: JSON.stringify({
                            ...plan,
                            monitorFingerprint: check.monitorFingerprint,
                            targetFingerprint: check.targetFingerprint,
                        }),
                    },
                    profile,
                    at,
                    cursor,
                    rollback
                );
                return { monitorID: check.monitorID, ...observed };
            })
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        const observed = results.map((result) => result.value);
        return {
            healthy: observed.every((item) => item.healthy),
            checks: observed,
            observations: observed.find((item) => item.monitorID === row.monitor_id)?.observations || [],
        };
    }
    /**
     * @param {object} row Retained code repair
     * @param {object} target Installed host capability
     * @param {string} operation Closed host operation
     * @param {object} extra Bound receipt fields
     * @returns {Promise<object>} Verified scoped result
     */
    async remote(row, target, operation, extra) {
        await this.ownsLease();
        const args = extra || (operation === "code_status" ? { jobID: row.remote_id } : this.args(row));
        let reply;
        for (let attempt = 0; attempt < 3; attempt++) {
            await this.ownsLease();
            try {
                reply = await client.request(target, operation, args);
                break;
            } catch (error) {
                if (operation !== "code_status" || error.message !== "projectCodeRecoveryMaintenance" || attempt === 2)
                    throw error;
                await this.sleep(2000);
            }
        }
        if (
            reply?.ok !== true ||
            reply.targetID !== row.target_id ||
            reply.jobID !== row.remote_id ||
            reply.sourceHash !== row.source_hash ||
            (row.plan_hash && reply.planHash && row.plan_hash !== reply.planHash)
        )
            throw problem("projectCodeRecoveryPolicy");
        return reply;
    }
    /**
     * @param {object} row Retained code repair
     * @param {object} target Installed host capability
     * @param {string} reason Fixed failure reason
     * @returns {Promise<void>} Persist or validate the next guarded phase
     */
    async compensate(row, target, reason) {
        try {
            const state = await this.remote(row, target, "code_status");
            if (state.backup?.expiresAt === null && /^[a-f0-9]{64}$/.test(state.backup.digest)) {
                await this.transition(row, row.status, {
                    backup_json: JSON.stringify({ ...state.backup, savedAt: this.now() }),
                });
            }
            if (["qualified", "backing_up", "backed_up"].includes(state.phase)) {
                await this.finish(row, row.cancel_requested ? "cancelled" : "failed", reason);
                return;
            }
            if (!["applied", "applying", "rolled_back"].includes(state.phase))
                throw problem("projectCodeRecoveryUncertain");
            await this.transition(
                row,
                "rolling_back",
                ["applied", "applying"].includes(state.phase) ? { applied_json: JSON.stringify(state) } : {}
            );
            const reply = state.phase === "rolled_back" ? state : await this.remote(row, target, "code_rollback");
            if (reply.phase !== "rolled_back" || !/^[a-f0-9]{64}$/.test(reply.rollbackHash))
                throw problem("projectCodeRecoveryUncertain");
            const last = await R.knex("heartbeat").where({ monitor_id: row.monitor_id }).orderBy("id", "desc").first();
            const at = this.now();
            await this.transition(row, "verifying_rollback", {
                rollback_json: JSON.stringify({ receipt: reply, healthy: false }),
            });
            const verified = await this.observe(row, target, at, last?.id || 0, true);
            const current = await this.remote(row, target, "code_status");
            if (current.phase !== "rolled_back" || current.currentHash !== reply.rollbackHash) {
                throw problem("projectCodeRecoveryConflict");
            }
            await this.transition(row, "verifying_rollback", {
                rollback_json: JSON.stringify({ receipt: reply, ...verified }),
            });
            await this.finish(row, verified.healthy ? "rolled_back" : "rollback_unhealthy", reason);
        } catch (error) {
            await this.finish(row, "uncertain", safeError(error));
        }
    }
    /**
     * @param {object} row Retained code repair
     * @returns {Promise<object>} Verified scoped result
     */
    async run(row) {
        let target;
        try {
            target = client.profiles().find((t) => t.id === row.target_id && t.projectID === row.project_id);
            if (!target) throw problem("projectRecoveryDrift");
            if (executing.includes(row.status) || row.status === "rollback_queued") {
                await this.compensate(row, target, "projectRecoveryInterrupted");
                return;
            }
            if (row.status === "staging") throw problem("projectCodeRecoveryInterrupted");
            const value = await this.forward(row);
            target = value.target;
            if (row.status === "generating") {
                const job = await R.knex("project_ai_job").where({ id: row.generation_id }).first();
                if (["queued", "running"].includes(job.status)) return;
                if (job.status !== "completed" || !job.code_result_cipher)
                    throw problem("projectCodeRecoveryGeneration");
                const proposal = patch.validate(
                    open(row.project_id, job.code_result_cipher),
                    value.evidence.codeRepair.source
                );
                if (proposal.remediation.action !== "code_patch") {
                    await this.finish(row, "rejected", "projectCodeRecoveryNoPatch");
                    return;
                }
                await this.transition(row, "staging");
                const stage = await this.remote(row, target, "code_stage", {
                    jobID: row.remote_id,
                    source: value.evidence.codeRepair.source,
                    patch: proposal.remediation,
                });
                if (
                    stage.phase !== "qualified" ||
                    stage.patchHash !== patch.hash(patch.canonical(proposal.remediation)) ||
                    !/^[a-f0-9]{64}$/.test(stage.qualificationHash) ||
                    !stage.qualification?.syntax ||
                    !stage.qualification.regressionFailedBefore ||
                    !stage.qualification.regressionPassedAfter ||
                    !(stage.qualification.tests > 0) ||
                    stage.qualification.network !== false ||
                    stage.qualification.productionData !== false
                )
                    throw problem("projectCodeRecoveryTest");
                await this.forward(row);
                await R.knex.transaction(async (tx) => {
                    await tx("project_ai_job")
                        .where({ id: row.review_id, status: "held" })
                        .update({
                            status: "queued",
                            code_input_cipher: seal(row.project_id, {
                                codeReview: {
                                    source: value.evidence.codeRepair.source,
                                    description: value.evidence.codeRepair.description,
                                    patch: proposal.remediation,
                                    qualification: stage.qualification,
                                    generatedChanges: stage.changes.filter((change) => change.cacheReferences?.length),
                                },
                            }),
                            updated_at: this.now(),
                        });
                    await tx(this.table)
                        .where({ id: row.id })
                        .update({
                            status: "reviewing",
                            stage_json: JSON.stringify(stage),
                            revision: R.knex.raw("revision + 1"),
                            updated_at: this.now(),
                        });
                });
                return;
            }
            if (row.status === "reviewing") {
                const review = await R.knex("project_ai_job").where({ id: row.review_id }).first();
                if (["queued", "running", "held"].includes(review.status)) return;
                if (review.status !== "completed" || !review.code_result_cipher)
                    throw problem("projectCodeRecoveryReview");
                const decision = patch.validateReview(open(row.project_id, review.code_result_cipher));
                if (decision.verdict !== "accept") {
                    await this.finish(row, "rejected", "projectCodeRecoveryReview");
                    return;
                }
                const stage = parse(row.stage_json);
                const generation = await R.knex("project_ai_job").where({ id: row.generation_id }).first();
                const proposal = patch.validate(
                    open(row.project_id, generation.code_result_cipher),
                    value.evidence.codeRepair.source
                );
                const plan = {
                    title: "Исправление кода сайта",
                    targetFingerprint: target.fingerprint,
                    monitorFingerprint: legacy.fingerprint(value.monitor),
                    sourceVersion: value.evidence.codeRepair.source.version,
                    sourceID: stage.sourceID,
                    checks: checkIdentity(value.evidence.checks),
                    sourceHash: row.source_hash,
                    patchHash: stage.patchHash,
                    qualificationHash: stage.qualificationHash,
                    qualification: stage.qualification,
                    changes: stage.changes,
                    review: decision,
                    regressionSHA256: patch.hash(proposal.remediation.test.code),
                    updatesDeferredUntilTransferred: true,
                    backupExpiresAt: null,
                };
                await this.transition(row, "planned", {
                    plan_json: JSON.stringify(plan),
                    plan_hash: patch.hash(JSON.stringify(plan)),
                    expires_at: this.now() + 900000,
                });
                await notify(row.id);
                return;
            }
            if (row.status !== "queued") throw problem("projectRecoveryStale");
            await this.transition(row, "backing_up");
            const backup = await this.remote(row, target, "code_backup");
            if (
                backup.phase !== "backed_up" ||
                !/^[a-f0-9]{64}$/.test(backup.backup?.digest) ||
                backup.backup.expiresAt !== null
            )
                throw problem("projectCodeRecoveryBackup");
            await this.transition(row, "backing_up", {
                backup_json: JSON.stringify({ ...backup.backup, savedAt: this.now() }),
            });
            await this.forward(row);
            await this.transition(row, "applying");
            const reply = await this.remote(row, target, "code_apply");
            if (reply.phase !== "applied" || !/^[a-f0-9]{64}$/.test(reply.afterHash))
                throw problem("projectCodeRecoveryUncertain");
            const at = this.now();
            const last = await R.knex("heartbeat").where({ monitor_id: row.monitor_id }).orderBy("id", "desc").first();
            await this.transition(row, "verifying", { applied_json: JSON.stringify(reply) });
            const verified = await this.observe(row, target, at, last?.id || 0);
            if (!verified.healthy) throw problem("projectRecoveryNoObservations");
            const status = await this.remote(row, target, "code_status");
            if (
                status.phase !== "applied" ||
                status.afterHash !== reply.afterHash ||
                status.currentHash !== reply.afterHash
            )
                throw problem("projectCodeRecoveryConflict");
            const saved = await R.knex(this.table).where({ id: row.id }).first();
            if (saved.cancel_requested) throw problem("projectRecoveryCancelled");
            await this.transition(row, "verifying", { verification_json: JSON.stringify(verified) });
            await this.finish(row, "succeeded");
        } catch (error) {
            const saved = await R.knex(this.table).where({ id: row.id }).first();
            if (target && executing.includes(saved.status) && saved.plan_hash && saved.approved_at)
                await this.compensate(saved, target, safeError(error));
            else await this.finish(saved, saved.cancel_requested ? "cancelled" : "failed", safeError(error));
        }
    }
}

const worker = new CodeRecoveryWorker();
/**
 * @param {number} jobID Retained action identity
 * @returns {Promise<void>} Persist or validate the next guarded phase
 */
async function notify(jobID) {
    try {
        await require("../notification-delivery").notifyCodeRecovery(jobID);
    } catch {
        /* Delivery history is independent of code execution. */
    }
}
module.exports = {
    overview,
    index,
    preview,
    generate,
    details,
    approve,
    cancel,
    rollback,
    reset,
    exportPatch,
    worker,
    CodeRecoveryWorker,
    working,
    publicJob,
    notify,
};
