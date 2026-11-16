const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, guard } = require("./project-workspace.cjs");
const { fakeClient, completion, stream, diagnosis } = require("./openai-grant.cjs");
const { getVault } = require("../../server/projects/vault");
const files = require("../../server/projects/recovery-files");
const recovery = require("../../server/projects/recovery");
const ai = require("../../server/projects/ai-service");
const ownerPassword = "synthetic-owner-recovery-password";

/**
 * Real private files, constraints, signed structured model protocol and captured explicit consent.
 * @param {object} t Lifecycle
 * @param {string} recommendation Fixed synthetic model choice
 * @returns {Promise<object>} Owned recovery context
 */
async function setup(t, recommendation = "restore_config") {
    const value = await fixture(t);
    const { db, projectID, monitorID, ids } = value;
    await db("user")
        .where({ id: 1 })
        .update({ password: await require("../../server/password-hash").generate(ownerPassword) });
    const vault = getVault();
    const root = path.join(value.folder, "owned-app");
    fs.mkdirSync(root, { mode: 0o700 });
    if (process.platform === "win32") {
        require("node:child_process").execFileSync(
            "icacls.exe",
            [
                root,
                "/inheritance:r",
                "/grant:r",
                `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,
                "*S-1-5-18:(OI)(CI)F",
            ],
            { stdio: "ignore", timeout: 10000, windowsHide: true }
        );
    }
    const file = path.join(root, "config.json");
    const baseline = path.join(root, "approved.json");
    const before = Buffer.from('{"broken":true,"password":"synthetic-private-configuration"}\n');
    const after = Buffer.from('{"broken":false,"password":"synthetic-private-configuration"}\n');
    fs.writeFileSync(file, before, { mode: 0o600 });
    fs.writeFileSync(baseline, after, { mode: 0o600 });
    const monitor = await db("monitor").where({ id: monitorID }).first();
    const target = {
        id: "owned-app",
        projectID,
        monitorID,
        title: "Owned application",
        root,
        file,
        baseline,
        baselineSha256: files.digest(after),
        checkURL: monitor.url,
        reload: { kind: "live" },
        verifySeconds: 60,
    };
    const manifest = path.join(path.dirname(vault.filename), "recovery-manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, targets: [target] }), { mode: 0o600 });
    const previousManifest = process.env.UPTIME_KUMA_RECOVERY_MANIFEST;
    process.env.UPTIME_KUMA_RECOVERY_MANIFEST = manifest;
    t.after(async () => {
        await recovery.worker.stop();
        recovery.worker.lockLost = false;
        recovery.worker.now = Date.now;
        recovery.worker.service = files.service;
        ai.setTestClient(undefined);
        if (previousManifest === undefined) {
            delete process.env.UPTIME_KUMA_RECOVERY_MANIFEST;
        } else {
            process.env.UPTIME_KUMA_RECOVERY_MANIFEST = previousManifest;
        }
    });
    const inputTime = new Date(Date.now() - 1000).toISOString();
    await db("heartbeat").insert({
        monitor_id: monitorID,
        time: inputTime,
        status: 0,
        msg: "HTTP 503",
        check_interval: 20,
        check_session: "owned-continuous-session",
    });
    await db("project_ai")
        .where({ project_id: projectID })
        .update({
            mode: "api",
            model: "gpt-synthetic",
            state: "verified",
            daily_limit: 10,
            secret_cipher: vault.seal(projectID, { kind: "api", api_key: "synthetic-recovery-api-key" }),
        });
    const requests = [];
    ai.setTestClient(
        fakeClient((_url, options) => {
            requests.push(JSON.parse(options.body));
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
                                                action: recommendation,
                                                reason: "Synthetic owner-approved configuration recovery proposal.",
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
    const request = { projectID, monitorID, targetID: target.id, kind: "recovery" };
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
    assert.equal((await db("project_ai_job").where({ id: aiJobID }).first()).status, "completed");
    await recovery.worker.start();
    clearInterval(recovery.worker.timer);
    assert.equal(recovery.worker.ready, true);
    return { ...value, file, baseline, before, after, target, manifest, aiJobID, requests, preview };
}

/**
 * @param {object} value Owned fixture
 * @returns {Promise<object>} Approved one-shot job
 */
async function approve(value) {
    const plan = await recovery.createPlan(
        value.ids.operator,
        { projectID: value.projectID, aiJobID: value.aiJobID },
        guard
    );
    return recovery.approve(1, { ...plan, projectID: value.projectID, password: ownerPassword, confirm: true }, guard);
}

/**
 * Unit-only observation producer. Browser acceptance separately uses actual HTTP monitoring.
 * @param {object} value Owned files and SQL
 * @param {object} job Approved action
 * @param {string} mode Outcome
 * @returns {Promise<object>} Retained action outcome
 */
async function run(value, job, mode = "healthy") {
    let stop = false;
    let offset = 0;
    recovery.worker.now = () => Date.now() + offset;
    const observations = (async () => {
        while (!stop) {
            const current = await value.db("project_recovery").where({ id: job.id }).first();
            if (["verifying", "verifying_rollback"].includes(current.status)) {
                if (mode !== "healthy") {
                    offset += 30000;
                }
                if (mode !== "missing") {
                    const healthy = mode === "healthy" && fs.readFileSync(value.file).equals(value.after);
                    await value.db("heartbeat").insert({
                        monitor_id: value.monitorID,
                        time: new Date(recovery.worker.now()).toISOString(),
                        status: healthy ? 1 : 0,
                        check_interval: 20,
                        check_session: "owned-continuous-session",
                    });
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 80));
        }
    })();
    try {
        await recovery.worker.run(await value.db("project_recovery").where({ id: job.id }).first());
    } finally {
        stop = true;
        await observations;
    }
    return value.db("project_recovery").where({ id: job.id }).first();
}

module.exports = { setup, approve, run, ownerPassword };
