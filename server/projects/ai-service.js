const { R } = require("redbean-node");
const { createHash } = require("node:crypto");
const { permit, id, problem, audit } = require("./access");
const { getVault } = require("./vault");
const { OpenAIClient, AIError } = require("./openai-client");
const { AnthropicClient } = require("./anthropic-client");
const { parentIsInactive } = require("./store");
const { currentServiceState, issueExplanation, serviceHost, observationTime } = require("../../src/overview-state.ts");
const { workFromBeat } = require("../../src/site-work.ts");
const active = new Map();
const locks = new Map();
let clientOverride;

/**
 * @param {string} mode Closed saved connection type
 * @returns {OpenAIClient|AnthropicClient} Official provider client for this project
 */
function client(mode = "api") {
    const Provider = mode === "anthropic" ? AnthropicClient : OpenAIClient;
    return clientOverride || new Provider({ fetch: require("../ai-worker/transport").fetchForInstallation() });
}
/**
 * @param {OpenAIClient} value Test-only dependency
 * @returns {void} Install isolated transport
 */
function setTestClient(value) {
    clientOverride = value;
}
/**
 * @param {number} projectID Scope
 * @template T
 * @param {function(): Promise<T>} action Serialized action
 * @returns {Promise<T>} Action result
 */
async function locked(projectID, action) {
    const previous = locks.get(projectID) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    const settled = next.catch(() => {});
    locks.set(projectID, settled);
    try {
        return await next;
    } finally {
        if (locks.get(projectID) === settled) {
            locks.delete(projectID);
        }
    }
}
/**
 * @param {number} projectID Scope
 * @param {number|undefined} jobID Abort only this job when specified
 * @returns {void} Abort bounded active work
 */
function cancelActive(projectID, jobID) {
    const running = active.get(projectID);
    if (running && (jobID === undefined || running.jobID === jobID)) {
        running.controller.abort();
    }
}
/**
 * @param {unknown} value Number
 * @param {number} min Lower
 * @param {number} max Upper
 * @returns {number} Valid integer
 * @throws {Error} Invalid value or unavailable protected data
 */
function integer(value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw problem("projectInvalid");
    }
    return value;
}
/**
 * @param {object} row Stored config
 * @returns {object} Server-only credentials
 * @throws {Error} Invalid value or unavailable protected data
 */
function secretFor(row) {
    if (!row.secret_cipher) {
        throw problem("projectAINotConnected");
    }
    return getVault().open(row.project_id, row.secret_cipher);
}
/**
 * @param {object} beat Stored observation
 * @param {boolean} http Whether this check observes an HTTP response
 * @param {boolean} history Whether the consented interval belongs in the preview
 * @returns {object} Typed facts, never an arbitrary response or error string
 */
function aiObservation(beat, http, history = false) {
    const time = observationTime(beat.time);
    const result = { time: time === null ? null : new Date(time).toISOString(), status: beat.status, ping: beat.ping };
    if (history) result.interval = beat.check_interval ?? null;
    if (http) {
        const status = String(beat.msg || "").match(
            /(?:\bHTTP(?:\/[\d.]+)?\s+|\bstatus(?:\s+code)?[\s:=]+)([1-5]\d{2})\b/i
        );
        if (status) result.httpStatus = Number(status[1]);
    }
    const work = workFromBeat(beat);
    if (work) result.work = { kind: work.kind, phase: work.phase };
    return result;
}

/**
 * @param {object} row Config
 * @returns {object} Secret-free settings
 */
function publicSettings(row) {
    let registration = null;
    let models = [];
    try {
        registration = JSON.parse(row.registration_json);
        models = JSON.parse(row.models_json) || [];
    } catch {
        /* No retained catalog yet. */
    }
    return {
        revision: row.revision,
        mode: row.mode,
        model: row.model || "",
        dailyLimit: row.daily_limit,
        timeoutSeconds: row.timeout_seconds,
        maxOutputTokens: row.max_output_tokens,
        allowNames: Boolean(row.allow_names),
        allowHosts: Boolean(row.allow_hosts),
        allowHistory: Boolean(row.allow_history),
        hasSecret: Boolean(row.secret_cipher),
        hasRegistration: Boolean(registration?.client_id),
        state: row.state,
        verifiedAt: row.verified_at,
        errorCode: row.error_code,
        account: registration?.email || "",
        models,
    };
}
/**
 * @param {number} userID Actor
 * @param {number} projectID Project
 * @returns {Promise<object>} Administrator settings
 */
async function settings(userID, projectID) {
    await permit(userID, projectID, "admin");
    const config = await R.knex("project_ai").where({ project_id: projectID }).first();
    await permit(userID, projectID, "admin");
    return publicSettings(config);
}
/**
 * @param {number} userID Actor
 * @param {object} request Form/revision
 * @param {Function} guard Current identity
 * @returns {Promise<object>} Saved settings, optional unconfirmed revocation
 */
async function saveSettings(userID, request, guard) {
    const projectID = id(request.projectID);
    await permit(userID, projectID, "admin");
    await guard();
    cancelActive(projectID);
    return locked(projectID, async () => {
        // A save can wait behind an in-flight request while its actor loses access.
        await guard();
        await permit(userID, projectID, "admin");
        const current = await R.knex("project_ai").where({ project_id: projectID }).first();
        if (current.revision !== request.revision || !["off", "api", "subscription", "anthropic"].includes(request.mode)) {
            throw problem("projectChanged");
        }
        const values = {
            mode: request.mode,
            model: request.model || null,
            daily_limit: integer(request.dailyLimit, 1, 1000),
            timeout_seconds: integer(request.timeoutSeconds, 10, 120),
            max_output_tokens: integer(request.maxOutputTokens, 256, 8192),
            allow_names: request.allowNames === true ? 1 : 0,
            allow_hosts: request.allowHosts === true ? 1 : 0,
            allow_history: request.allowHistory === true ? 1 : 0,
            revision: current.revision + 1,
            verified_at: null,
            error_code: null,
            state: request.mode === "off" ? "off" : "saved",
        };
        let models = [];
        try {
            models = JSON.parse(current.models_json) || [];
        } catch {
            /* No catalog. */
        }
        if (values.model && (typeof values.model !== "string" || !models.some((model) => model.id === values.model))) {
            throw problem("projectAIChooseModel");
        }
        const sameConnection = current.mode === request.mode;
        let secret = sameConnection && current.secret_cipher ? secretFor(current) : null;
        if (request.mode === "api" || request.mode === "anthropic") {
            if (request.apiKey) {
                if (typeof request.apiKey !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(request.apiKey)) {
                    throw problem("projectAIKeyRequired");
                }
                secret = { kind: "api", mode: request.mode, api_key: request.apiKey };
            } else if (secret?.kind !== "api" || (secret.mode || "api") !== request.mode) {
                throw problem("projectAIKeyRequired");
            }
        } else if (request.mode === "subscription" && secret?.kind !== "subscription") {
            secret = null;
        }
        let revoked = true;
        if (current.secret_cipher && current.mode === "subscription" && request.mode !== "subscription") {
            await guard();
            await permit(userID, projectID, "admin");
            revoked = await client().revoke(secretFor(current));
        }
        if (request.mode === "off") {
            secret = null;
        }
        values.secret_cipher = secret ? getVault().seal(projectID, secret) : null;
        if (!sameConnection || request.apiKey) {
            values.models_json = null;
            values.model = null;
        }
        if (!sameConnection) {
            values.registration_json = null;
            values.allow_names = 0;
            values.allow_hosts = 0;
            values.allow_history = 0;
        }
        await R.knex.transaction(async (tx) => {
            await guard(tx);
            const scope = await permit(userID, projectID, "admin", tx);
            const changed = await tx("project_ai")
                .where({ project_id: projectID, revision: request.revision })
                .update(values);
            if (!changed) {
                throw problem("projectChanged");
            }
            if (!sameConnection && current.mode !== "off") {
                await tx("project_ai_automation")
                    .where({ project_id: projectID, enabled: 1 })
                    .update({ enabled: 0, updated_at: Date.now() });
            }
            await tx("project_ai_job")
                .where({ project_id: projectID, status: "queued" })
                .update({ status: "cancelled", error_code: "changed", updated_at: Date.now() });
            await tx("project_oauth_pairing")
                .where({ project_id: projectID })
                .whereNull("used_at")
                .update({ used_at: Date.now() });
            await audit(tx, scope, request.mode === "off" ? "aiDisconnected" : "aiConfigured");
            await guard(tx);
        });
        return { remoteRevoked: revoked, settings: await settings(userID, projectID) };
    });
}
/**
 * @param {object} row Config
 * @param {AbortSignal} signal Cancellation
 * @returns {Promise<string>} Current isolated bearer
 */
async function bearer(row, signal) {
    let secret = secretFor(row);
    if (["api", "anthropic"].includes(row.mode) && secret.kind === "api" && (secret.mode || "api") === row.mode) {
        return secret.api_key;
    }
    if (row.mode !== "subscription" || secret.kind !== "subscription") {
        throw new AIError("auth");
    }
    if (secret.expires_at <= Date.now() + 60000) {
        const earliest =
            typeof secret.earliest_refresh_at === "number"
                ? secret.earliest_refresh_at * 1000
                : Date.parse(secret.earliest_refresh_at || "");
        if (Number.isFinite(earliest) && earliest > Date.now()) {
            if (secret.expires_at <= Date.now()) {
                throw new AIError("auth");
            }
            return secret.access_token;
        }
        secret = await client().refresh(secret, signal);
        const changed = await R.knex("project_ai")
            .where({ project_id: row.project_id, revision: row.revision })
            .update({
                secret_cipher: getVault().seal(row.project_id, secret),
                registration_json: JSON.stringify({
                    client_id: secret.client_id,
                    subject: secret.subject,
                    email: secret.email,
                }),
            });
        if (!changed) {
            throw new AIError("changed");
        }
    }
    return secret.access_token;
}
/**
 * @param {number} userID Actor
 * @param {object} request Project/revision
 * @param {Function} guard Current identity
 * @returns {Promise<object[]>} Fresh account catalog
 */
async function models(userID, request, guard) {
    const projectID = id(request.projectID);
    return locked(projectID, async () => {
        await permit(userID, projectID, "admin");
        const row = await R.knex("project_ai").where({ project_id: projectID }).first();
        if (row.revision !== request.revision || row.mode === "off") {
            throw problem("projectChanged");
        }
        await guard();
        const signal = AbortSignal.timeout(30000);
        const token = await bearer(row, signal);
        await guard();
        await permit(userID, projectID, "admin");
        const catalog = await client(row.mode).models(token, row.mode, signal);
        await R.knex.transaction(async (tx) => {
            await guard(tx);
            await permit(userID, projectID, "admin", tx);
            const changed = await tx("project_ai")
                .where({ project_id: projectID, revision: row.revision })
                .update({ models_json: JSON.stringify(catalog), error_code: null });
            if (!changed) {
                throw problem("projectChanged");
            }
        });
        return catalog;
    });
}
/**
 * @param {object} row Config
 * @param {object|null} monitor Check
 * @param {object[]} beats Observations
 * @returns {object} Only consented data
 */
function evidenceFor(row, monitor, beats = []) {
    if (!monitor) {
        return {
            purpose: "connection-test",
            state: "unknown",
            observations: [],
            limitations: ["No real service data was supplied. This is only a connection test."],
        };
    }
    const current = currentServiceState(monitor, beats);
    const http = ["http", "keyword", "json-query"].includes(monitor.type);
    const latest = current.latest ? aiObservation(current.latest, http) : null;
    const reason = current.state === "up" ? null : issueExplanation(current.state, current.latest?.msg);
    const failures = {
        workspaceIssue404: { category: "http_not_found", httpStatus: 404 },
        workspaceIssueAccess: { category: "http_access_denied" },
        workspaceIssueRate: { category: "http_rate_limit", httpStatus: 429 },
        workspaceIssueServer: { category: "http_server_error" },
        workspaceIssueDNS: { category: "dns_resolution_failed" },
        workspaceIssueTLS: { category: "tls_validation_failed" },
        workspaceIssueTimeout: { category: "connection_timeout" },
        workspaceIssueSlow: { category: "response_time_limit" },
        workspaceIssueProjectTarget: { category: "network_policy_blocked" },
    };
    const evidence = {
        monitorID: monitor.id,
        type: monitor.type,
        state: current.state,
        reason,
        failure: current.state === "down" ? failures[reason] || { category: "unreachable" } : null,
        responseLimitMs: monitor.max_response_time ?? null,
        semantics: {
            timezone: "UTC",
            units: { ping: "milliseconds", interval: "seconds", responseLimitMs: "milliseconds" },
            statuses: {
                0: "confirmed failure",
                1: "successful check",
                2: "retry pending; failure unconfirmed",
                3: "planned work; availability not confirmed",
            },
        },
        latest,
        limitations: [
            "Only retained observations are available. Gaps are not uptime. Exact downtime is not established.",
        ],
    };
    if (evidence.failure && latest?.httpStatus) evidence.failure.httpStatus = latest.httpStatus;
    if (row.allow_names) {
        evidence.name = String(monitor.name || "")
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .slice(0, 120);
    }
    if (row.allow_hosts) {
        evidence.host = serviceHost(monitor);
    }
    if (row.allow_history) {
        evidence.observations = beats.slice(-8).map((beat) => aiObservation(beat, http, true));
    }
    return evidence;
}
/**
 * @param {number} userID Actor
 * @param {object} request Project/check
 * @param {object} db Connection
 * @param {object|null} hostEvidence Internal host facts inspected before the transaction
 * @returns {Promise<object>} Exact safe evidence preview
 */
async function prepare(userID, request, db = R.knex, hostEvidence = null) {
    const scope = await permit(userID, id(request.projectID), "operator", db);
    const row = await db("project_ai").where({ project_id: scope.id }).first();
    const monitor = await db("monitor")
        .where({ id: id(request.monitorID), user_id: scope.data_user_id })
        .first();
    if (!monitor || monitor.type === "group") {
        throw problem();
    }
    if (monitor.parent) {
        const ancestors = await db("monitor").where({ user_id: scope.data_user_id }).select("id", "active", "parent");
        monitor.forceInactive = parentIsInactive(monitor, new Map(ancestors.map((row) => [row.id, row])));
    }
    const beats = await db("heartbeat")
        .where({ monitor_id: monitor.id })
        .orderBy("time", "desc")
        .orderBy("id", "desc")
        .limit(8);
    const evidence = evidenceFor(row, monitor, beats.reverse());
    if (request.kind === "recovery") {
        const driver = request.recoveryDriver === "site" ? "./site-recovery" : "./recovery";
        evidence.recovery =
            driver === "./site-recovery" && hostEvidence
                ? await require(driver).retainedCapability(scope, monitor, request.targetID, hostEvidence, db)
                : await require(driver).capability(scope, monitor, request.targetID, db);
    }
    return {
        evidence,
        hash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
        revision: row.revision,
    };
}
/**
 * @param {string} timezone Project timezone
 * @returns {string} Local accounting day
 */
function bucketDay(timezone) {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts();
    return ["year", "month", "day"].map((kind) => parts.find((part) => part.type === kind).value).join("-");
}
/**
 * @param {number} userID Actor
 * @param {object} request Project/kind/consent hash
 * @param {Function} guard Live guard
 * @param {object|null} automatic Internal event policy, never accepted from a socket payload
 * @returns {Promise<number>} Durable one-shot work
 */
async function enqueue(userID, request, guard, automatic = null) {
    const kind = request.kind;
    if (!["probe", "diagnosis", "recovery"].includes(kind)) {
        throw problem("projectInvalid");
    }
    // SSH health inspection must not hold SQLite's single writer connection.
    // Recheck the exact local incident on the transaction; the host identity is
    // revalidated again before a plan, backup and any actual change.
    const hostPreview =
        kind === "recovery" && request.recoveryDriver === "site" ? await prepare(userID, request) : null;
    return R.knex.transaction(async (tx) => {
        const scope = await permit(userID, id(request.projectID), kind === "probe" ? "admin" : "operator", tx);
        const row = await tx("project_ai").where({ project_id: scope.id }).first();
        if (row.revision !== request.revision || !row.secret_cipher || row.mode === "off" || !row.model) {
            throw problem("projectAINotConnected");
        }
        if (kind !== "probe" && row.state !== "verified") {
            throw problem("projectAINeedProbe");
        }
        const day = bucketDay(scope.timezone);
        const count = await tx("project_ai_job")
            .where({ project_id: scope.id, bucket_day: day })
            .count({ n: "id" })
            .first();
        if (Number(count.n) >= row.daily_limit) {
            throw problem("projectAIDailyLimit");
        }
        const pending = await tx("project_ai_job")
            .where({ project_id: scope.id })
            .whereIn("status", ["queued", "running"])
            .first();
        if (pending) {
            throw problem("projectAIBusy");
        }
        const queued = await tx("project_ai_job").whereIn("status", ["queued", "running"]).count({ n: "id" }).first();
        if (Number(queued.n) >= 100) {
            throw problem("projectAIBusy");
        }
        let evidence = evidenceFor(row, null);
        if (kind !== "probe") {
            const preview = await prepare(userID, request, tx, hostPreview?.evidence.recovery);
            if (preview.hash !== request.evidenceHash) {
                throw problem("projectAIEvidenceChanged");
            }
            evidence = preview.evidence;
        }
        if (automatic) {
            if (kind !== "diagnosis") throw problem("projectInvalid");
            await require("./ai-automation").claim(tx, scope, row, automatic, day);
        }
        const [jobID] = await tx("project_ai_job").insert({
            project_id: scope.id,
            user_id: userID,
            monitor_id: kind !== "probe" ? request.monitorID : null,
            revision: row.revision,
            project_revision: scope.revision,
            kind,
            trigger: automatic ? "automatic" : "manual",
            automation_revision: automatic?.policyRevision || null,
            status: "queued",
            bucket_day: day,
            input_json: JSON.stringify(evidence),
            created_at: Date.now(),
            updated_at: Date.now(),
        });
        if (automatic) {
            await tx("project_ai_incident")
                .where({ project_id: scope.id, monitor_id: request.monitorID })
                .update({ last_job_id: jobID });
        }
        await audit(
            tx,
            scope,
            automatic
                ? "aiAutomaticDiagnosisQueued"
                : kind === "probe"
                  ? "aiProbeQueued"
                  : kind === "recovery"
                    ? "aiRecoveryQueued"
                    : "aiDiagnosisQueued",
            jobID
        );
        await guard(tx);
        return jobID;
    });
}
/**
 * @param {number} userID Actor
 * @param {object} request Project/job
 * @param {Function} guard Live authorization with the selected job
 * @returns {Promise<boolean>} Whether the selected request was stopped
 */
async function cancelJob(userID, request, guard) {
    const projectID = id(request.projectID);
    const jobID = id(request.id);
    const changed = await R.knex.transaction(async (tx) => {
        const scope = await permit(userID, projectID, "operator", tx);
        const job = await tx("project_ai_job").where({ id: jobID, project_id: projectID }).forUpdate().first();
        if (!job || (job.kind === "probe" && scope.role !== "admin")) {
            throw problem();
        }
        const updated = await tx("project_ai_job")
            .where({ id: job.id })
            .whereIn("status", ["queued", "running"])
            .update({ status: "cancelled", error_code: "cancelled", updated_at: Date.now() });
        if (updated) {
            await audit(tx, scope, "aiJobCancelled", job.id);
        }
        await guard(tx, job);
        return Boolean(updated);
    });
    if (changed) {
        cancelActive(projectID, jobID);
    }
    return changed;
}
/**
 * @param {number} userID Actor
 * @param {number} projectID Project
 * @returns {Promise<object[]>} Completed diagnoses and honest state
 */
async function jobs(userID, projectID) {
    await permit(userID, projectID);
    const rows = await R.knex("project_ai_job").where({ project_id: projectID }).orderBy("id", "desc").limit(30);
    const result = rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        trigger: row.trigger,
        monitorID: row.monitor_id,
        status: row.status,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        errorCode: row.error_code,
        result: row.code_result_cipher ? null : row.result_json ? JSON.parse(row.result_json) : null,
        usage: row.usage_json ? JSON.parse(row.usage_json) : null,
        recoveryTargetID: row.kind === "recovery" ? JSON.parse(row.input_json)?.recovery?.targetID || null : null,
        recoveryDriver: row.kind === "recovery" ? JSON.parse(row.input_json)?.recovery?.driver || "local" : null,
    }));
    await permit(userID, projectID);
    return result;
}

/** One-shot bounded requests. A process interruption never silently repeats paid work. */
class AIWorker {
    /** @returns {Promise<void>} Recover durable state */
    async start() {
        this.stopped = false;
        this.tasks = new Set();
        await R.knex("project_ai_job")
            .where({ status: "running" })
            .update({ status: "uncertain", error_code: "interrupted", updated_at: Date.now() });
        this.timer = setInterval(() => this.tick(), 1000);
        this.timer.unref();
    }
    /** @returns {Promise<void>} Stop claiming and abort active HTTP requests */
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        for (const { controller } of active.values()) {
            controller.abort();
        }
        await Promise.allSettled(this.tasks || []);
    }
    /** @returns {Promise<void>} At most two project-isolated workers */
    async tick() {
        if (this.stopped || this.claiming || this.tasks.size >= 2) {
            return;
        }
        this.claiming = true;
        try {
            const query = R.knex("project_ai_job").where({ status: "queued" }).orderBy("id");
            if (active.size) {
                query.whereNotIn("project_id", [...active.keys()]);
            }
            const job = await query.first();
            if (!job) {
                return;
            }
            const controller = new AbortController();
            active.set(job.project_id, { jobID: job.id, controller });
            const task = locked(job.project_id, () => this.run(job, controller))
                .catch(() => {})
                .finally(() => {
                    active.delete(job.project_id);
                    this.tasks.delete(task);
                });
            this.tasks.add(task);
        } catch {
            /* No provider error or credential is logged. */
        } finally {
            this.claiming = false;
        }
    }
    /**
     * @param {object} job Saved request
     * @param {AbortController} controller Cancellation
     * @returns {Promise<void>} Final state
     */
    async run(job, controller) {
        const required = job.kind === "probe" ? "admin" : "operator";
        let started = false;
        let timer;
        const valid = async (db = R.knex) => {
            const scope = await permit(job.user_id, job.project_id, required, db);
            if (["code_patch", "code_review"].includes(job.kind))
                await require("./recovery").owner(job.user_id, job.project_id, db);
            await require("./ai-automation").validateJob(db, job, !started);
            const row = await db("project_ai").where({ project_id: job.project_id, revision: job.revision }).first();
            const saved = await db("project_ai_job").where({ id: job.id }).first();
            if (
                !row ||
                scope.revision !== job.project_revision ||
                !["queued", "running"].includes(saved?.status) ||
                controller.signal.aborted
            ) {
                throw new AIError("changed");
            }
            return row;
        };
        try {
            const row = await valid();
            const claimed = await R.knex("project_ai_job")
                .where({ id: job.id, status: "queued" })
                .update({ status: "running", updated_at: Date.now() });
            if (!claimed) {
                return;
            }
            timer = setTimeout(() => controller.abort(), row.timeout_seconds * 1000);
            const token = await bearer(row, controller.signal);
            await valid();
            started = true;
            const evidence = job.code_input_cipher
                ? getVault().open(job.project_id, job.code_input_cipher, "code")
                : JSON.parse(job.input_json);
            const answer = await client(row.mode).diagnose(row, token, evidence, controller.signal);
            // Known bearer credentials must never reappear in a provider's returned text.
            let result = JSON.stringify(answer.result);
            const secret = secretFor(await valid());
            for (const key of ["api_key", "access_token", "refresh_token", "id_token"]) {
                if (secret[key]) {
                    result = result.split(secret[key]).join("[hidden]");
                }
            }
            await R.knex.transaction(async (tx) => {
                await valid(tx);
                await tx("project_ai_job")
                    .where({ id: job.id, status: "running" })
                    .update({
                        status: "completed",
                        result_json: job.code_input_cipher ? null : result,
                        code_result_cipher: job.code_input_cipher
                            ? getVault().seal(job.project_id, JSON.parse(result), "code")
                            : null,
                        usage_json: JSON.stringify(answer.usage),
                        updated_at: Date.now(),
                    });
                if (job.kind === "probe") {
                    await tx("project_ai")
                        .where({ project_id: job.project_id, revision: job.revision })
                        .update({ state: "verified", verified_at: Date.now(), error_code: null });
                }
                await audit(tx, { id: job.project_id, actor_id: job.user_id }, "aiJobCompleted", job.id);
            });
        } catch (error) {
            let code = "unavailable";
            if (error instanceof AIError) {
                code = error.code;
            } else if (error.message === "projectAccessDenied") {
                code = "changed";
            }
            let status = "failed";
            if (code === "changed" || (controller.signal.aborted && !started)) {
                status = "cancelled";
            } else if (
                started &&
                (controller.signal.aborted || ["timeout", "incomplete", "unavailable"].includes(code))
            ) {
                status = "uncertain";
            }
            await R.knex.transaction(async (tx) => {
                const changed = await tx("project_ai_job")
                    .where({ id: job.id })
                    .whereIn("status", ["queued", "running"])
                    .update({
                        status,
                        error_code: controller.signal.aborted ? "cancelled" : code,
                        updated_at: Date.now(),
                    });
                if (changed) {
                    await audit(tx, { id: job.project_id, actor_id: job.user_id }, "aiJobFailed", job.id);
                }
            });
            if (["auth", "limit"].includes(code)) {
                await R.knex("project_ai")
                    .where({ project_id: job.project_id, revision: job.revision })
                    .update({ state: code === "auth" ? "expired" : "limited", error_code: code });
            }
        } finally {
            clearTimeout(timer);
        }
    }
}

const worker = new AIWorker();
module.exports = {
    settings,
    saveSettings,
    models,
    prepare,
    enqueue,
    cancelJob,
    jobs,
    publicSettings,
    evidenceFor,
    bearer,
    locked,
    cancelActive,
    client,
    setTestClient,
    worker,
    AIWorker,
    bucketDay,
};
