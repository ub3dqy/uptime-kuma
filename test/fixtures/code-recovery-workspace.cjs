const assert = require("node:assert/strict");
const { fixture, guard } = require("./project-workspace.cjs");
const { fakeClient, completion, stream, diagnosis } = require("./openai-grant.cjs");
const { getVault } = require("../../server/projects/vault");
const code = require("../../server/projects/code-recovery");
const client = require("../../server/projects/site-recovery-client");
const ai = require("../../server/projects/ai-service");
const patch = require("../../server/projects/code-patch");
const password = "synthetic-code-owner-password";

/**
 * @param {object} t Test lifecycle
 * @param {object} options Isolated execution dependencies
 * @returns {Promise<object>} Verified scoped result
 */
async function setup(t, options = {}) {
    const value = await fixture(t);
    const { db, projectID, monitorID } = value;
    await db("user")
        .where({ id: 1 })
        .update({ password: await require("../../server/password-hash").generate(password) });
    await db("project_ai")
        .where({ project_id: projectID })
        .update({
            mode: "api",
            model: "gpt-synthetic",
            state: "verified",
            daily_limit: options.limit || 10,
            secret_cipher: getVault().seal(projectID, { kind: "api", api_key: "synthetic-key" }),
        });
    const target = {
        id: "site-code",
        projectID,
        monitorID,
        ownerID: 1,
        title: "Synthetic site",
        action: "restart_service",
        fingerprint: "a".repeat(64),
        verifySeconds: 65,
        checkURL: (await db("monitor").where({ id: monitorID }).first()).url,
    };
    const file = {
        path: "lib/format.cjs",
        sha256: patch.hash("module.exports = n => n + 1;\n"),
        bytes: 29,
        windows: [{ offset: 0, text: "module.exports = n => n + 1;\n" }],
    };
    const proposal = {
        ...diagnosis,
        remediation: {
            action: "code_patch",
            reason: "Fix the reproduced off-by-one defect.",
            changes: [{ path: file.path, beforeHash: file.sha256, edits: [{ before: "n + 1", after: "n + 2" }] }],
            test: {
                language: "javascript",
                code: "const {test}=require('node:test');const assert=require('node:assert/strict');const f=require('/app/lib/format.cjs');test('expected result',()=>{assert.equal(f(2),4);});",
            },
        },
    };
    const host = { calls: [], phase: null, afterHash: "b".repeat(64), healthy: true, ...options.host };
    const targets = [target];
    client.setTestTransport({
        config: { targets },
        request: async (_target, operation, args) => {
            host.calls.push({ operation, args });
            if (host.fail === operation) throw new Error("projectCodeRecoveryBackup");
            if (operation === "code_index")
                return {
                    ok: true,
                    targetID: target.id,
                    version: "synthetic-version",
                    files: [{ path: file.path, bytes: file.bytes }],
                    language: "javascript",
                };
            if (operation === "code_source")
                return {
                    ok: true,
                    targetID: target.id,
                    jobID: args.jobID,
                    source: {
                        targetID: target.id,
                        jobID: args.jobID,
                        sourceHash: "c".repeat(64),
                        runtimeHash: "d".repeat(64),
                        policyHash: "e".repeat(64),
                        version: "synthetic-version",
                        language: "javascript",
                        files: [file],
                    },
                };
            if (operation === "code_stage") {
                host.phase = "qualified";
                host.patchHash = patch.hash(patch.canonical(args.patch));
            }
            if (operation === "code_backup") host.phase = "backed_up";
            if (operation === "code_apply") {
                assert.equal(host.phase, "backed_up");
                host.phase = "applied";
                host.afterApply?.();
                if (host.dropAfterApply) {
                    host.dropAfterApply = false;
                    throw new Error("synthetic-lost-acknowledgement");
                }
            }
            if (operation === "code_rollback") {
                host.phase = "rolled_back";
                host.healthy = options.rollbackHealthy !== false;
            }
            return {
                ok: true,
                targetID: target.id,
                sourceID: "synthetic-site",
                jobID: args.jobID,
                sourceHash: "c".repeat(64),
                patchHash: host.patchHash,
                qualificationHash: "f".repeat(64),
                phase: host.phase,
                planHash: args.planHash || null,
                qualification: {
                    syntax: true,
                    regressionFailedBefore: true,
                    regressionPassedAfter: true,
                    tests: 1,
                    network: false,
                    productionData: false,
                },
                changes: [{ path: file.path, beforeHash: file.sha256, afterHash: "a".repeat(64) }],
                backup: { digest: "a".repeat(64), files: 1, expiresAt: null, databaseIncluded: true },
                afterHash: host.phase === "applied" ? host.afterHash : null,
                currentHash: host.phase === "rolled_back" ? "d".repeat(64) : host.afterHash,
                rollbackHash: host.phase === "rolled_back" ? "d".repeat(64) : null,
            };
        },
    });
    const requests = [];
    ai.setTestClient(
        fakeClient((_url, input) => {
            const body = JSON.parse(input.body);
            requests.push(body);
            const result =
                body.text.format.name === "code_patch_independent_review"
                    ? {
                          verdict: options.rejectReview ? "reject" : "accept",
                          summary: "Reviewed the exact behavior fix and regression.",
                          findings: [],
                          limitations: ["Only this reproduction was tested."],
                      }
                    : proposal;
            return stream([
                {
                    type: "response.completed",
                    response: completion({
                        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }],
                    }),
                },
            ]);
        })
    );
    await db("heartbeat").insert({
        monitor_id: monitorID,
        status: 1,
        time: new Date().toISOString().replace("T", " ").replace("Z", ""),
        check_interval: 20,
        check_session: "code-session",
    });
    await code.worker.start();
    clearInterval(code.worker.timer);
    code.worker.timer = null;
    t.after(async () => {
        await code.worker.stop();
        code.worker.now = Date.now;
        code.worker.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        client.setTestTransport(undefined);
        ai.setTestClient(undefined);
    });
    const request = {
        projectID,
        monitorID,
        targetID: target.id,
        paths: [{ path: file.path, offset: 0 }],
        description: "For input 2 the function returns 3. It must return 4.",
    };
    return { ...value, request, proposal, host, target, targets, requests };
}
/**
 * @returns {Promise<void>} Persist or validate the next guarded phase
 */
async function model() {
    const worker = new ai.AIWorker();
    await worker.start();
    try {
        await worker.tick();
        await Promise.all([...worker.tasks]);
    } finally {
        await worker.stop();
    }
}
/**
 * @param {object} value Untrusted structured model response
 * @returns {Promise<object>} Verified scoped result
 */
async function plan(value) {
    const preview = await code.preview(1, value.request);
    const created = await code.generate(
        1,
        { projectID: value.projectID, token: preview.token, hash: preview.hash, confirm: true },
        guard
    );
    await model();
    await code.worker.run(await value.db("project_code_recovery").where({ id: created.id }).first());
    assert.equal((await value.db("project_code_recovery").where({ id: created.id }).first()).status, "reviewing");
    await model();
    await code.worker.run(await value.db("project_code_recovery").where({ id: created.id }).first());
    return (await code.overview(1, value.projectID)).jobs.find((j) => j.id === created.id);
}
/**
 * @param {object} value Untrusted structured model response
 * @param {object} job Retained action
 * @param {string} mode Synthetic observation mode
 * @returns {Promise<object>} Verified scoped result
 */
async function run(value, job, mode = "healthy") {
    let clock = Date.now();
    let sleeping;
    code.worker.now = () => clock;
    code.worker.sleep = () => {
        // Parallel address checks wait on the same clock and get one batch of samples.
        sleeping ??= new Promise((resolve) => setImmediate(resolve)).then(async () => {
            clock += 20000;
            await code.worker.lease();
            if (mode !== "missing") {
                await value.db("heartbeat").insert(
                    [value.monitorID, ...(value.extraMonitorIDs || [])].map((monitorID) => ({
                        monitor_id: monitorID,
                        status: mode === "healthy" && value.host.healthy ? 1 : 0,
                        time: new Date(clock).toISOString().replace("T", " ").replace("Z", ""),
                        check_interval: 20,
                        check_session: "code-session",
                    }))
                );
            }
        }).finally(() => {
            sleeping = null;
        });
        return sleeping;
    };
    await code.worker.run(await value.db("project_code_recovery").where({ id: job.id }).first());
    return value.db("project_code_recovery").where({ id: job.id }).first();
}
module.exports = { setup, plan, run, password, guard, code, model };
