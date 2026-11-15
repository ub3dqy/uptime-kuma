const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setup, approve, run, ownerPassword } = require("../fixtures/recovery-workspace.cjs");
const { getVault } = require("../../server/projects/vault");
const files = require("../../server/projects/recovery-files");
const recovery = require("../../server/projects/recovery");
const { validateDiagnosis } = require("../../server/projects/openai-client");
const { diagnosis } = require("../fixtures/openai-grant.cjs");
const { guard } = require("../fixtures/project-workspace.cjs");

test("cancellation after saving a snapshot but before replacement does not restart or modify the application", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    const original = files.replace;
    t.mock.method(files, "replace", async (...args) => {
        const row = await value.db("project_recovery").where({ id: job.id }).first();
        await recovery.cancel(1, { projectID: value.projectID, id: job.id, revision: row.revision }, guard);
        return original(...args);
    });
    let mutations = 0;
    recovery.worker.service = async (_target, action) => {
        if (action && action !== "read") {
            mutations++;
        }
        return "live";
    };
    const result = await run(value, job);
    assert.equal(result.status, "cancelled");
    assert.equal(mutations, 0);
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});

test("owner cancellation after replacement compensates the already-approved change", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    recovery.worker.service = async (_target, action) => {
        if (action === "apply") {
            assert.deepEqual(fs.readFileSync(value.file), value.after);
            const current = await value.db("project_recovery").where({ id: job.id }).first();
            await recovery.cancel(1, { projectID: value.projectID, id: job.id, revision: current.revision }, guard);
        }
        return "live";
    };
    const result = await run(value, job, "failed");
    assert.equal(result.status, "rolled_back");
    assert.equal(result.error_code, "projectRecoveryCancelled");
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});

test("an unavailable recovery point blocks the forward filesystem write", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    const vault = getVault();
    const original = vault.seal.bind(vault);
    t.mock.method(vault, "seal", (...args) => {
        if (args[2] === "recovery") {
            throw new Error("Synthetic durable backup failure");
        }
        return original(...args);
    });
    const result = await run(value, job);
    assert.equal(result.status, "failed");
    assert.equal(result.snapshot_cipher, null);
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});

test("an unsuccessful rollback retains its point and never reports success", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    const original = files.replace;
    t.mock.method(files, "replace", async (target, expected, bytes, ...rest) => {
        if (bytes.equals(value.before)) {
            throw new Error("Synthetic restore write failure");
        }
        return original(target, expected, bytes, ...rest);
    });
    const result = await run(value, job, "failed");
    assert.equal(result.status, "rollback_failed");
    assert.ok(result.snapshot_cipher);
    assert.equal(recovery.publicJob(result).canRollback, true);
    assert.deepEqual(fs.readFileSync(value.file), value.after);
    assert.equal((await recovery.overview(1, value.projectID)).breakers.length, 1);
});

test("an interrupted uncertain systemd rollback is not blindly restarted a second time", async (t) => {
    const value = await setup(t);
    const completed = await run(value, await approve(value));
    const snapshot = getVault().open(value.projectID, completed.snapshot_cipher, "recovery");
    snapshot.target.reload = { kind: "systemd", unit: `kuma-managed-p${value.projectID}-${value.target.id}.service` };
    snapshot.unitState = "active";
    const cipher = getVault().seal(value.projectID, snapshot, "recovery");
    fs.writeFileSync(value.file, value.before);
    await value
        .db("project_recovery")
        .where({ id: completed.id })
        .update({ status: "recovering", snapshot_cipher: cipher, reload_phase: "rollback_started" });
    let restarts = 0;
    recovery.worker.service = async () => {
        restarts++;
        return "active";
    };
    const result = await run(value, completed);
    assert.equal(result.status, "rollback_unverified");
    assert.equal(restarts, 0);
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});

test("rate limits survive cancellation, explicit breaker reset and new proposals", async (t) => {
    const value = await setup(t);
    const first = await approve(value);
    await recovery.cancel(1, { projectID: value.projectID, id: first.id, revision: first.revision }, guard);
    await recovery.worker.run(await value.db("project_recovery").where({ id: first.id }).first());
    assert.deepEqual(fs.readFileSync(value.file), value.before);
    const base = await value.db("project_ai_job").where({ id: value.aiJobID }).first();
    const { id: ignoredID, ...copy } = base;
    assert.ok(ignoredID);
    const [secondID] = await value.db("project_ai_job").insert(copy);
    const second = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: secondID }, guard);
    await assert.rejects(
        recovery.approve(1, { ...second, projectID: value.projectID, password: ownerPassword, confirm: true }, guard),
        /projectRecoveryRateLimit/
    );
    // Only this synthetic database's accounting timestamps simulate elapsed time.
    await value
        .db("project_recovery")
        .where({ id: first.id })
        .update({ approved_at: Date.now() - 300001 });
    const queued = await recovery.approve(
        1,
        { ...second, projectID: value.projectID, password: ownerPassword, confirm: true },
        guard
    );
    await recovery.cancel(1, { projectID: value.projectID, id: queued.id, revision: queued.revision }, guard);
    await recovery.worker.run(await value.db("project_recovery").where({ id: queued.id }).first());
    assert.deepEqual(fs.readFileSync(value.file), value.before);
    assert.equal((await value.db("project_recovery").whereNotNull("approved_at")).length, 2);
    await value
        .db("project_recovery")
        .whereNotNull("approved_at")
        .update({ approved_at: Date.now() - 300001 });
    const [thirdID] = await value.db("project_ai_job").insert(copy);
    const third = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: thirdID }, guard);
    const thirdQueued = await recovery.approve(
        1,
        { ...third, projectID: value.projectID, password: ownerPassword, confirm: true },
        guard
    );
    await recovery.cancel(1, { projectID: value.projectID, id: thirdQueued.id, revision: thirdQueued.revision }, guard);
    await recovery.worker.run(await value.db("project_recovery").where({ id: thirdQueued.id }).first());
    await value
        .db("project_recovery")
        .whereNotNull("approved_at")
        .update({ approved_at: Date.now() - 300001 });
    const [fourthID] = await value.db("project_ai_job").insert(copy);
    const fourth = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: fourthID }, guard);
    await assert.rejects(
        recovery.approve(1, { ...fourth, projectID: value.projectID, password: ownerPassword, confirm: true }, guard),
        /projectRecoveryRateLimit/
    );
    assert.equal((await value.db("project_recovery").whereNotNull("approved_at")).length, 3);
});

test("a changed incident and tampered consent cannot authorize an old proposal", async (t) => {
    const value = await setup(t);
    const plan = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: value.aiJobID }, guard);
    await assert.rejects(
        recovery.approve(
            1,
            { ...plan, projectID: value.projectID, planHash: "0".repeat(64), password: ownerPassword, confirm: true },
            guard
        ),
        /projectRecoveryStale/
    );
    for (const status of [1, 0]) {
        await value.db("heartbeat").insert({
            monitor_id: value.monitorID,
            time: new Date().toISOString(),
            status,
            msg: status === 0 ? "HTTP 503" : "",
            check_interval: 20,
            check_session: "owned-continuous-session",
        });
    }
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID: value.projectID, password: ownerPassword, confirm: true }, guard),
        /projectRecoveryStale/
    );
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});

test("changed HTTP redirect rules invalidate an approved queued change before writing its configuration", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    await value.db("monitor").where({ id: value.monitorID }).update({ maxredirects: 0 });
    const result = await run(value, job);
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "projectRecoveryStale");
    assert.equal(result.snapshot_cipher, null);
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});

test("recovery schemas and installation policies reject new commands, other paths, duplicate targets and invalid baselines", async (t) => {
    const value = await setup(t);
    for (const remediation of [
        { action: "shell", reason: "Run arbitrary command" },
        { action: "restore_config", reason: "safe", command: "untrusted" },
    ]) {
        assert.throws(() => validateDiagnosis({ ...diagnosis, remediation }, true), /response/);
    }
    const original = JSON.parse(fs.readFileSync(value.manifest, "utf8"));
    const outside = path.join(path.dirname(value.manifest), "unrelated.json");
    fs.writeFileSync(outside, "{}", { mode: 0o600 });
    fs.writeFileSync(value.manifest, JSON.stringify({ version: 1, targets: [{ ...value.target, file: outside }] }));
    assert.throws(() => files.profiles(), /projectRecoveryPolicy/);
    fs.writeFileSync(
        value.manifest,
        JSON.stringify({ version: 1, targets: [value.target, { ...value.target, id: "duplicate" }] })
    );
    assert.throws(() => files.profiles(), /projectRecoveryPolicy/);
    fs.writeFileSync(value.manifest, JSON.stringify(original));
    const keyFolder = path.dirname(getVault().filename);
    fs.writeFileSync(
        value.manifest,
        JSON.stringify({
            version: 1,
            targets: [{ ...value.target, root: keyFolder, file: getVault().filename, baseline: value.manifest }],
        })
    );
    assert.throws(() => files.profiles(), /projectRecoveryPolicy/);
    fs.writeFileSync(value.manifest, JSON.stringify(original));
    fs.writeFileSync(value.baseline, "not JSON");
    assert.throws(() => files.inspect(files.profiles()[0]), /projectRecoveryBaseline/);
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});

test("loss of the executor lock blocks approval and is reported as unavailable", async (t) => {
    const value = await setup(t);
    const plan = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: value.aiJobID }, guard);
    fs.unlinkSync(recovery.worker.filename);
    assert.equal((await recovery.overview(1, value.projectID)).executorReady, false);
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID: value.projectID, password: ownerPassword, confirm: true }, guard),
        /projectRecoveryExecutor/
    );
    assert.deepEqual(fs.readFileSync(value.file), value.before);
});
