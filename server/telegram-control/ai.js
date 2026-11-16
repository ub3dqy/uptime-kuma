const { R } = require("redbean-node");
const { levels, problem } = require("../projects/access");
const ai = require("../projects/ai-service");
const automation = require("../projects/ai-automation");

const pending = ["queued", "running"];

/**
 * @param {object} config Bound Kuma user and project
 * @param {Function} authorize Current project role and Telegram channel check
 * @param {Function} panelLink Trusted link to the project's AI panel
 * @returns {object} Telegram operations for diagnosis
 */
function projectAI(config, authorize, panelLink) {
    const { userId, projectId } = config;
    /**
     * @param {object} expected Scope at the time of reading or confirming
     * @param {string} role Minimum role
     * @param {object} db Connection or transaction
     * @returns {Promise<void>} Reject stale access or project changes
     */
    async function stillAuthorized(expected, role, db = R.knex) {
        const scope = await authorize(role, db);
        if (
            scope.revision !== expected.revision ||
            scope.data_user_id !== expected.data_user_id ||
            scope.role !== expected.role
        ) {
            throw problem("projectChanged");
        }
    }

    /**
     * @param {string} role Minimum role
     * @param {Function} read Scoped read
     * @returns {Promise<object>} Data from the authorized project
     */
    async function view(role, read) {
        const scope = await authorize(role);
        const result = await read(scope);
        await stillAuthorized(scope, role);
        return result;
    }

    /**
     * @param {object} scope Authorized project
     * @param {number} id Selected monitor
     * @param {object} db Connection or transaction
     * @returns {Promise<object>} Named monitor in this project
     */
    async function namedMonitor(scope, id, db = R.knex) {
        const query = db("monitor").where({ id, user_id: scope.data_user_id }).whereNot("type", "group");
        if (db.isTransaction) {
            query.forShare();
        }
        const row = await query.first("id", "name");
        if (!row) {
            throw problem();
        }
        return row;
    }

    /**
     * @param {object} scope Authorized project
     * @returns {object} Only diagnosis jobs of current project monitors
     */
    function diagnoses(scope) {
        return R.knex("project_ai_job as j")
            .join("monitor as m", "m.id", "j.monitor_id")
            .where({ "j.project_id": projectId, "j.kind": "diagnosis", "m.user_id": scope.data_user_id })
            .whereNot("m.type", "group");
    }

    /**
     * @param {object} scope Authorized project
     * @param {object} job Job already restricted to this project
     * @returns {boolean} The actor may cancel this particular manual diagnosis
     */
    function canCancel(scope, job) {
        return (
            levels[scope.role] >= levels.operator &&
            job.user_id === userId &&
            job.trigger === "manual" &&
            pending.includes(job.status)
        );
    }

    return {
        overview(monitorID = null) {
            return view("viewer", async (scope) => {
                const monitor = monitorID === null ? null : await namedMonitor(scope, monitorID);
                const config = await R.knex("project_ai").where({ project_id: projectId }).first("state");
                const query = diagnoses(scope);
                if (monitor) {
                    query.where("j.monitor_id", monitor.id);
                }
                const rows = await query.select("j.id", "j.status", "m.name").orderBy("j.id", "desc").limit(8);
                let automatic = null;
                if (!monitor && scope.role === "admin") {
                    const policy = await automation.settings(userId, projectId);
                    automatic = "off";
                    if (policy.enabled) {
                        automatic = policy.active ? "active" : "needsReview";
                    }
                }
                return {
                    monitor,
                    rows,
                    automatic,
                    state: config?.state || "off",
                    canRun: config?.state === "verified" && levels[scope.role] >= levels.operator,
                    url: await panelLink(monitorID),
                };
            });
        },
        job(id) {
            return view("viewer", async (scope) => {
                const row = await diagnoses(scope)
                    .leftJoin("project_ai as a", "a.project_id", "j.project_id")
                    .where("j.id", id)
                    .first(
                        "j.id",
                        "j.status",
                        "j.trigger",
                        "j.user_id",
                        "j.monitor_id",
                        "j.created_at",
                        "j.error_code",
                        "j.result_json",
                        "j.revision",
                        "j.project_revision",
                        "a.revision as current_revision",
                        "m.name"
                    );
                if (!row) {
                    throw problem();
                }
                const current = row.revision === row.current_revision && row.project_revision === scope.revision;
                const result =
                    current && row.status === "completed" && row.result_json ? JSON.parse(row.result_json) : null;
                return {
                    id: row.id,
                    name: row.name,
                    monitorID: row.monitor_id,
                    status: row.status,
                    trigger: row.trigger,
                    createdAt: Number(row.created_at),
                    errorCode: row.error_code,
                    canCancel: canCancel(scope, row),
                    result,
                    timezone: scope.timezone,
                    url: await panelLink(row.monitor_id),
                };
            });
        },
        prepare(monitorID) {
            return view("operator", async (scope) => {
                const monitor = await namedMonitor(scope, monitorID);
                const config = await R.knex("project_ai")
                    .where({ project_id: projectId })
                    .whereNotNull("secret_cipher")
                    .first("mode", "state", "model", "revision");
                if (!config || config.mode === "off" || !config.model) {
                    throw problem("projectAINotConnected");
                }
                if (config.state !== "verified") {
                    throw problem("projectAINeedProbe");
                }
                const preview = await ai.prepare(userId, { projectID: projectId, monitorID, kind: "diagnosis" });
                if (preview.revision !== config.revision) {
                    throw problem("projectChanged");
                }
                return { action: "aiDiagnosis", monitorID, name: monitor.name, preview, scope };
            });
        },
        enqueue({ monitorID, name, preview, scope }) {
            return ai.enqueue(
                userId,
                {
                    projectID: projectId,
                    monitorID,
                    kind: "diagnosis",
                    revision: preview.revision,
                    evidenceHash: preview.hash,
                },
                async (db) => {
                    await stillAuthorized(scope, "operator", db);
                    if ((await namedMonitor(scope, monitorID, db)).name !== name) {
                        throw problem("projectChanged");
                    }
                }
            );
        },
        prepareCancel(id) {
            return view("operator", async (scope) => {
                const row = await diagnoses(scope)
                    .where("j.id", id)
                    .first("j.id", "j.user_id", "j.trigger", "j.status", "j.monitor_id", "m.name");
                if (!row || !canCancel(scope, row)) {
                    throw problem("telegramAICancelUnavailable");
                }
                return { action: "aiCancel", argument: row.id, monitorID: row.monitor_id, name: row.name, scope };
            });
        },
        async cancel({ argument, monitorID, scope }) {
            const stopped = await ai.cancelJob(userId, { projectID: projectId, id: argument }, async (db, job) => {
                await stillAuthorized(scope, "operator", db);
                if (job.kind !== "diagnosis" || job.monitor_id !== monitorID || !canCancel(scope, job)) {
                    throw problem("telegramAICancelUnavailable");
                }
                await namedMonitor(scope, monitorID, db);
            });
            if (!stopped) {
                throw problem("telegramAICancelUnavailable");
            }
        },
    };
}

module.exports = { projectAI };
