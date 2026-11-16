const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { setup, approve, run, ownerPassword } = require("../fixtures/recovery-workspace.cjs");
const { getVault } = require("../../server/projects/vault");
const recovery = require("../../server/projects/recovery");
const { guard } = require("../fixtures/project-workspace.cjs");

test("AI proposal and concrete plan cannot change files; only the actual owner with fresh password can approve", async (t) => {
    const value = await setup(t);
    const { projectID, otherID, aiJobID, ids, file, before, requests } = value;
    const plan = await recovery.createPlan(ids.operator, { projectID, aiJobID }, guard);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(plan.status, "planned");
    for (const privateText of [file, "synthetic-private-configuration", "password", value.baseline]) {
        assert.equal(JSON.stringify(requests).includes(privateText), false);
        assert.equal(JSON.stringify(plan).includes(privateText), false);
    }
    await assert.rejects(recovery.createPlan(ids.viewer, { projectID, aiJobID }, guard));
    await assert.rejects(recovery.createPlan(2, { projectID: otherID, aiJobID }, guard));
    await assert.rejects(
        recovery.approve(ids.admin, { ...plan, projectID, password: "synthetic-password-1234", confirm: true }, guard),
        /projectRecoveryOwnerOnly/
    );
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID, password: "wrong", confirm: true }, guard),
        /projectRecoveryPassword/
    );
    await assert.rejects(recovery.approve(1, { ...plan, projectID, password: ownerPassword, confirm: false }, guard));
    const queued = await recovery.approve(1, { ...plan, projectID, password: ownerPassword, confirm: true }, guard);
    const repeated = await recovery.approve(1, { ...plan, projectID, password: ownerPassword, confirm: true }, guard);
    assert.equal(queued.id, repeated.id);
    assert.equal((await value.db("project_recovery").count({ n: "id" }).first()).n, 1);
    assert.deepEqual(fs.readFileSync(file), before);
    const visible = await recovery.overview(ids.viewer, projectID);
    assert.equal(visible.isOwner, false);
    assert.equal(JSON.stringify(visible).includes(file), false);
});

test("durable encrypted recovery point precedes an actual file replacement, two fresh successes and manual rollback", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    const result = await run(value, job);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(fs.readFileSync(value.file), value.after);
    assert.equal(result.snapshot_cipher.includes("synthetic-private-configuration"), false);
    const point = getVault().open(value.projectID, result.snapshot_cipher, "recovery");
    assert.deepEqual(Buffer.from(point.bytes, "base64"), value.before);
    assert.throws(() => getVault().open(value.otherID, result.snapshot_cipher, "recovery"));
    assert.throws(() => getVault().open(value.projectID, result.snapshot_cipher, "ai"));
    assert.equal(JSON.parse(result.verification_json).observations.length, 2);
    assert.equal(JSON.parse(result.verification_json).healthy, true);
    const completed = recovery.publicJob(result);
    await recovery.rollback(
        1,
        { ...completed, projectID: value.projectID, confirm: true, password: ownerPassword },
        guard
    );
    const restored = await run(value, completed);
    assert.equal(restored.status, "rolled_back");
    assert.deepEqual(fs.readFileSync(value.file), value.before);
    assert.equal(JSON.parse(restored.rollback_verification_json).healthy, false);
    assert.ok(restored.snapshot_cipher);
    assert.equal((await recovery.overview(1, value.projectID)).breakers.length, 1);
});

test("failed verification automatically restores exact prior bytes and blocks further attempts", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    const result = await run(value, job, "failed");
    assert.equal(result.status, "rolled_back");
    assert.equal(result.error_code, "projectRecoveryNoObservations");
    assert.deepEqual(fs.readFileSync(value.file), value.before);
    assert.equal(JSON.parse(result.rollback_verification_json).healthy, false);
    assert.equal((await recovery.overview(1, value.projectID)).breakers.length, 1);
    await recovery.reset(1, { projectID: value.projectID, targetID: value.target.id, password: ownerPassword }, guard);
    assert.equal((await recovery.overview(1, value.projectID)).breakers.length, 0);
});

test("missing monitoring data never establishes success, including after a restored file", async (t) => {
    const value = await setup(t);
    const result = await run(value, await approve(value), "missing");
    assert.equal(result.status, "rollback_unverified");
    assert.deepEqual(fs.readFileSync(value.file), value.before);
    assert.equal(result.verification_json, null);
    assert.equal(result.rollback_verification_json, null);
});

test("changed files and expired plans fail closed; model refusal creates no executable plan", async (t) => {
    const value = await setup(t);
    const plan = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: value.aiJobID }, guard);
    const external = Buffer.from('{"external":"preserve-this"}');
    fs.writeFileSync(value.file, external);
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID: value.projectID, password: ownerPassword, confirm: true }, guard),
        /projectRecoveryDrift/
    );
    assert.deepEqual(fs.readFileSync(value.file), external);
    fs.writeFileSync(value.file, value.before);
    await value
        .db("project_recovery")
        .where({ id: plan.id })
        .update({ expires_at: Date.now() - 1 });
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID: value.projectID, password: ownerPassword, confirm: true }, guard),
        /projectRecoveryStale/
    );
    const row = await value.db("project_ai_job").where({ id: value.aiJobID }).first();
    const result = JSON.parse(row.result_json);
    result.remediation.action = "none";
    await value
        .db("project_ai_job")
        .where({ id: row.id })
        .update({ result_json: JSON.stringify(result) });
    await assert.rejects(
        recovery.createPlan(1, { projectID: value.projectID, aiJobID: row.id }, guard),
        /projectRecoveryNoRecommendation/
    );
});

test("queued authorization loss and cancellation prevent forward writes", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    await value.db("project_member").where({ project_id: value.projectID, user_id: 1 }).delete();
    const result = await run(value, job);
    assert.equal(result.status, "failed");
    assert.deepEqual(fs.readFileSync(value.file), value.before);
    assert.equal(result.snapshot_cipher, null);
});

test("an external edit after successful recovery is preserved when owner requests rollback", async (t) => {
    const value = await setup(t);
    const result = await run(value, await approve(value));
    assert.equal(result.status, "succeeded");
    const external = Buffer.from('{"external":"new-independent-decision"}');
    fs.writeFileSync(value.file, external);
    const completed = recovery.publicJob(result);
    await recovery.rollback(
        1,
        { ...completed, projectID: value.projectID, confirm: true, password: ownerPassword },
        guard
    );
    const restored = await run(value, completed);
    assert.equal(restored.status, "conflict");
    assert.deepEqual(fs.readFileSync(value.file), external);
    assert.ok(restored.snapshot_cipher);
});

test("a second worker cannot acquire the installation lock", async (t) => {
    await setup(t);
    const second = new recovery.RecoveryWorker();
    await second.start();
    assert.equal(second.ready, false);
    await second.stop();
    recovery.worker.ownsLock();
});

test("key rotation retains both current and older encrypted recovery points", async (t) => {
    const value = await setup(t);
    const result = await run(value, await approve(value));
    const old = result.snapshot_cipher;
    const vault = getVault();
    await vault.rotate(value.db);
    const current = await value.db("project_recovery").where({ id: result.id }).first();
    assert.notEqual(current.snapshot_cipher, old);
    for (const cipher of [old, current.snapshot_cipher]) {
        assert.deepEqual(Buffer.from(vault.open(value.projectID, cipher, "recovery").bytes, "base64"), value.before);
    }
});
