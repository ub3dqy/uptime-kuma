const assert = require("node:assert/strict");
const { fixture, guard } = require("./project-workspace.cjs");
const { fakeClient, completion, stream, diagnosis } = require("./openai-grant.cjs");
const { getVault } = require("../../server/projects/vault");
const recovery = require("../../server/projects/site-recovery");
const client = require("../../server/projects/site-recovery-client");
const ai = require("../../server/projects/ai-service");
const password = "synthetic-site-owner-password";

/**
 * @param {object} t Test lifecycle
 * @param {object} options Fixed fixture options
 * @returns {Promise<object>} Actual SQL/roles/schema with a closed fake host transport and model
 */
async function setup(t, options = {}) {
    const value = await fixture(t);
    const { db, projectID, monitorID, ids } = value;
    await db("user")
        .where({ id: 1 })
        .update({ password: await require("../../server/password-hash").generate(password) });
    if (options.personal) await db("project").where({ id: projectID }).update({ personal: 1 });
    await db("project_ai")
        .where({ project_id: projectID })
        .update({
            mode: "api",
            model: "gpt-synthetic",
            state: "verified",
            daily_limit: 10,
            secret_cipher: getVault().seal(projectID, { kind: "api", api_key: "synthetic-key" }),
        });
    const target = {
        id: "site-owned",
        projectID,
        monitorID,
        ownerID: 1,
        title: "Owned site",
        action: options.action || "restart_service",
        fingerprint: "a".repeat(64),
        verifySeconds: 65,
        checkURL: (await db("monitor").where({ id: monitorID }).first()).url,
    };
    const host = {
        hash: "b".repeat(64),
        policy: "c".repeat(64),
        phase: null,
        calls: [],
        healthy: false,
        ...options.host,
    };
    client.setTestTransport({
        config: { targets: [target] },
        request: async (_target, operation, args) => {
            host.calls.push({ operation, args });
            if (host.fail === operation) throw new Error("synthetic-transport-error-with-private-body");
            if (operation === "inspect")
                return {
                    ok: true,
                    targetID: target.id,
                    action: target.action,
                    eligible: !host.healthy,
                    currentHash: host.hash,
                    policyHash: host.policy,
                    facts: { localHTTPStatus: host.healthy ? 200 : 503 },
                };
            if (operation === "backup") host.phase = "backed_up";
            if (operation === "apply") {
                assert.equal(host.phase, "backed_up");
                host.phase = "applied";
                host.hash = "d".repeat(64);
                host.healthy = true;
                host.afterApply?.();
                if (host.dropAfterApply) {
                    host.dropAfterApply = false;
                    throw new Error("synthetic-lost-response");
                }
            }
            if (operation === "rollback") {
                assert.ok(["applied", "applying"].includes(host.phase));
                host.phase = "rolled_back";
                host.hash = "b".repeat(64);
                host.healthy = Boolean(options.rollbackHealthy);
            }
            if (!host.phase) throw new Error("projectSiteRecoveryConflict");
            return {
                ok: true,
                targetID: target.id,
                jobID: args.jobID,
                planHash: args.planHash,
                phase: host.phase,
                backup: { digest: "e".repeat(64), files: 2, databaseIncluded: true, expiresAt: null },
                afterHash: host.phase === "applied" ? host.hash : null,
                rollbackHash: host.phase === "rolled_back" ? host.hash : null,
                at: Date.now(),
            };
        },
    });
    await db("heartbeat").insert({
        monitor_id: monitorID,
        time: new Date(Date.now() - 500).toISOString().replace("T", " ").replace("Z", ""),
        status: 0,
        msg: "HTTP 503",
        check_interval: 20,
        check_session: "site-continuous-session",
    });
    const requests = [];
    ai.setTestClient(
        fakeClient((_url, input) => {
            requests.push(JSON.parse(input.body));
            return stream([
                {
                    type: "response.completed",
                    response: completion({
                        output: [
                            {
                                type: "message",
                                content: [
                                    {
                                        type: "output_text",
                                        text: JSON.stringify({
                                            ...diagnosis,
                                            remediation: {
                                                action: options.recommendation || target.action,
                                                reason: "Synthetic installed action proposal.",
                                            },
                                        }),
                                    },
                                ],
                            },
                        ],
                    }),
                },
            ]);
        })
    );
    t.after(async () => {
        await recovery.worker.stop();
        recovery.worker.now = Date.now;
        recovery.worker.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        client.setTestTransport(undefined);
        ai.setTestClient(undefined);
    });
    const request = { projectID, monitorID, targetID: target.id, kind: "recovery", recoveryDriver: "site" };
    const preview = await ai.prepare(ids.operator, request);
    const aiJobID = await ai.enqueue(
        ids.operator,
        { ...request, revision: preview.revision, evidenceHash: preview.hash },
        guard
    );
    const worker = new ai.AIWorker();
    await worker.start();
    try {
        await worker.tick();
        await Promise.all([...worker.tasks]);
    } finally {
        await worker.stop();
    }
    assert.equal((await db("project_ai_job").where({ id: aiJobID }).first()).status, options.aiStatus || "completed");
    await recovery.worker.start();
    clearInterval(recovery.worker.timer);
    recovery.worker.timer = null;
    assert.equal(recovery.worker.ready, true);
    return { ...value, target, host, requests, preview, aiJobID };
}

/**
 * @param {object} value Fixture
 * @returns {Promise<object>} Owner-approved queued row
 */
async function approve(value) {
    const plan = await recovery.createPlan(
        value.ids.operator,
        { projectID: value.projectID, aiJobID: value.aiJobID },
        guard
    );
    return recovery.approve(1, { ...plan, projectID: value.projectID, password, confirm: true }, guard);
}

/**
 * @param {object} value Fixture
 * @param {object} job Row
 * @param {string} mode Observation mode
 * @returns {Promise<object>} Durable outcome
 */
async function run(value, job, mode = "healthy") {
    let clock = Date.now();
    recovery.worker.now = () => clock;
    recovery.worker.sleep = async () => {
        clock += 20000;
        await recovery.worker.lease();
        const current = await value.db("project_site_recovery").where({ id: job.id }).first();
        if (mode !== "missing")
            await value.db("heartbeat").insert({
                monitor_id: value.monitorID,
                time: new Date(clock).toISOString().replace("T", " ").replace("Z", ""),
                status: mode === "healthy" && value.host.healthy ? 1 : 0,
                check_interval: 20,
                check_session: mode === "sessions" ? "session-" + clock : "site-continuous-session",
            });
        if (mode === "cancel" && current.status === "verifying")
            await value.db("project_site_recovery").where({ id: job.id }).update({ cancel_requested: 1 });
    };
    await recovery.worker.run(await value.db("project_site_recovery").where({ id: job.id }).first());
    return value.db("project_site_recovery").where({ id: job.id }).first();
}
module.exports = { setup, approve, run, password };
