const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, plan, run, password, guard, code } = require("../fixtures/code-recovery-workspace.cjs");
const { getVault } = require("../../server/projects/vault");

test("code preview and retained source require the actual owner; two AI requests reserve the unchanged daily budget", async (t) => {
    const v = await setup(t, { limit: 1 });
    await assert.rejects(code.index(v.ids.admin, v.request), /projectRecoveryOwnerOnly/);
    await assert.rejects(code.preview(v.ids.operator, v.request), /projectAccessDenied/);
    await assert.rejects(code.preview(2, v.request));
    const p = await code.preview(1, v.request);
    await assert.rejects(
        code.generate(1, { projectID: v.projectID, token: p.token, hash: p.hash, confirm: false }, guard),
        /Consent/
    );
    await assert.rejects(
        code.generate(1, { projectID: v.projectID, token: p.token, hash: p.hash, confirm: true }, guard),
        /Budget/
    );
    assert.equal((await v.db("project_ai_job").count({ n: "id" }).first()).n, 0);
    assert.equal((await v.db("project_ai").where({ project_id: v.projectID }).first()).daily_limit, 1);
    assert.equal(
        v.host.calls.some((c) => c.operation === "code_stage"),
        false
    );
});

test("generation, failing-before/passing-after qualification and independent review produce an exact owner-gated plan", async (t) => {
    const v = await setup(t);
    const job = await plan(v);
    assert.equal(job.status, "planned");
    assert.equal(v.requests.length, 2);
    assert.ok(v.requests.every((r) => r.store === false && r.tools.length === 0 && r.model === "gpt-synthetic"));
    assert.equal(
        v.host.calls.some((c) => ["code_apply", "code_backup"].includes(c.operation)),
        false
    );
    const rows = await v.db("project_ai_job").where({ project_id: v.projectID });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.result_json === null && r.code_input_cipher && r.code_result_cipher));
    const generic = await require("../../server/projects/ai-service").jobs(v.ids.viewer, v.projectID);
    assert.ok(generic.every((j) => j.result === null));
    const other = (await code.overview(v.ids.admin, v.projectID)).jobs[0];
    assert.equal(other.plan, undefined);
    await assert.rejects(code.details(v.ids.admin, { projectID: v.projectID, id: job.id }), /OwnerOnly/);
    const details = await code.details(1, { projectID: v.projectID, id: job.id });
    assert.equal(details.proposal.remediation.changes[0].edits[0].after, "n + 2");
    await assert.rejects(
        code.approve(v.ids.admin, { ...job, projectID: v.projectID, password, confirm: true }, guard),
        /OwnerOnly/
    );
    await assert.rejects(
        code.approve(1, { ...job, projectID: v.projectID, password: "wrong", confirm: true }, guard),
        /Password/
    );
    await assert.rejects(code.approve(1, { ...job, projectID: v.projectID, password, confirm: false }, guard));
    const queued = await code.approve(1, { ...job, projectID: v.projectID, password, confirm: true }, guard);
    assert.equal(queued.job.status, "queued");
    assert.equal(
        (await code.approve(1, { ...job, projectID: v.projectID, password, confirm: true }, guard)).job.id,
        job.id
    );
});

test("backup precedes installation; two new observations verify success and retained export contains no launch secrets", async (t) => {
    const v = await setup(t);
    const job = await plan(v);
    await code.approve(1, { ...job, projectID: v.projectID, password, confirm: true }, guard);
    const result = await run(v, job);
    assert.equal(result.status, "succeeded");
    assert.equal(JSON.parse(result.backup_json).expiresAt, null);
    assert.equal(JSON.parse(result.verification_json).observations.length, 2);
    assert.deepEqual(
        v.host.calls.filter((c) => ["code_backup", "code_apply"].includes(c.operation)).map((c) => c.operation),
        ["code_backup", "code_apply"]
    );
    const exported = await code.exportPatch(1, { projectID: v.projectID, id: job.id });
    assert.equal(exported.package.expiresAt, null);
    assert.equal(exported.package.patch.action, "code_patch");
    assert.match(exported.package.serverJobID, /^[a-f0-9]{32}$/);
    assert.equal(exported.package.sourceID, "synthetic-site");
    assert.equal(JSON.stringify(exported).includes(password), false);
    const row = await v.db("project_code_recovery").where({ id: job.id }).first();
    assert.ok(row.source_cipher && !row.source_cipher.includes("module.exports"));
    assert.throws(() => getVault().open(v.otherID, row.source_cipher, "code"));
});

for (const mode of ["missing", "failed"])
    test(`${mode}: unconfirmed recovery triggers one rollback and a separate verification`, async (t) => {
        const v = await setup(t);
        const job = await plan(v);
        await code.approve(1, { ...job, projectID: v.projectID, password, confirm: true }, guard);
        const result = await run(v, job, mode);
        assert.equal(result.status, "rollback_unhealthy");
        assert.equal(v.host.calls.filter((c) => c.operation === "code_apply").length, 1);
        assert.equal(v.host.calls.filter((c) => c.operation === "code_rollback").length, 1);
        assert.equal(JSON.parse(result.rollback_json).healthy, false);
    });

test("lost apply acknowledgement is compensated from the durable host ledger without replay", async (t) => {
    const v = await setup(t, { host: { dropAfterApply: true } });
    const job = await plan(v);
    await code.approve(1, { ...job, projectID: v.projectID, password, confirm: true }, guard);
    const result = await run(v, job);
    assert.equal(result.status, "rolled_back");
    assert.equal(v.host.calls.filter((c) => c.operation === "code_apply").length, 1);
});

test("review rejection, revoked ownership and changed check block forward installation", async (t) => {
    const v = await setup(t, { rejectReview: true });
    const job = await plan(v);
    assert.equal(job.status, "rejected");
    assert.equal(
        v.host.calls.some((c) => c.operation === "code_backup"),
        false
    );
    await assert.rejects(code.approve(1, { ...job, projectID: v.projectID, password, confirm: true }, guard), /Stale/);
});

test("cancellation retains budget and source but never creates a site backup", async (t) => {
    const v = await setup(t);
    const job = await plan(v);
    await code.cancel(1, { projectID: v.projectID, id: job.id }, guard);
    await code.worker.tick();
    await code.worker.task;
    const row = await v.db("project_code_recovery").where({ id: job.id }).first();
    assert.equal(row.status, "cancelled");
    assert.ok(row.source_cipher);
    assert.equal((await v.db("project_ai_job").where({ project_id: v.projectID }).count({ n: "id" }).first()).n, 2);
    assert.equal(
        v.host.calls.some((c) => c.operation === "code_apply"),
        false
    );
});

test("missing observations and paused checks cannot start code sharing", async (t) => {
    const v = await setup(t);
    await v.db("heartbeat").where({ monitor_id: v.monitorID }).delete();
    await assert.rejects(code.preview(1, v.request), /projectCodeRecoveryMaintenance/);
    await v.db("monitor").where({ id: v.monitorID }).update({ active: 0 });
    await assert.rejects(code.index(1, v.request), /projectCodeRecoveryMaintenance/);
    assert.equal(v.host.calls.length, 0);
});

test("source consent cannot be reused after another administrator changes the AI connection", async (t) => {
    const v = await setup(t);
        const preview = await code.preview(1, v.request);
    await v
        .db("project_ai")
        .where({ project_id: v.projectID })
        .update({ revision: v.db.raw("revision + 1") });
    await assert.rejects(
        code.generate(1, { projectID: v.projectID, token: preview.token, hash: preview.hash, confirm: true }, guard),
        /projectAIEvidenceChanged/
    );
    assert.equal((await v.db("project_ai_job").where({ project_id: v.projectID }).count({ n: "id" }).first()).n, 0);
    assert.equal(
        v.host.calls.some((item) => item.operation === "code_stage"),
        false
    );
});

test("key rotation rewraps both AI requests and the retained consented code", async (t) => {
    const v = await setup(t);
        const job = await plan(v);
        const vault = getVault();
    const before = await v.db("project_code_recovery").where({ id: job.id }).first();
    const plain = vault.open(v.projectID, before.source_cipher, "code");
    await vault.rotate(v.db);
    const after = await v.db("project_code_recovery").where({ id: job.id }).first();
    assert.notEqual(after.source_cipher, before.source_cipher);
    assert.deepEqual(getVault().open(v.projectID, after.source_cipher, "code"), plain);
    for (const row of await v.db("project_ai_job").where({ project_id: v.projectID })) {
        assert.ok(getVault().open(v.projectID, row.code_input_cipher, "code"));
        assert.ok(getVault().open(v.projectID, row.code_result_cipher, "code"));
    }
    assert.equal(
        (await code.details(1, { projectID: v.projectID, id: job.id })).proposal.remediation.action,
        "code_patch"
    );
});

for (const readiness of [true, false])
    test(`all installed site checks require fresh results; readiness observed=${readiness}`, async (t) => {
        const v = await setup(t);
        const original = await v.db("monitor").where({ id: v.monitorID }).first();
        delete original.id;
        const url = new URL(v.target.checkURL);
        url.pathname = "/ready";
        const [otherID] = await v.db("monitor").insert({ ...original, name: "Readiness", url: url.href });
        v.targets.push({
            ...v.target,
            id: "site-ready",
            monitorID: otherID,
            checkURL: url.href,
            fingerprint: "9".repeat(64),
        });
        await v.db("heartbeat").insert({
            monitor_id: otherID,
            status: 1,
            time: new Date().toISOString().replace("T", " ").replace("Z", ""),
            check_interval: 20,
            check_session: "code-session",
        });
        const job = await plan(v);
        assert.equal(job.plan.checks.length, 2);
        if (readiness) v.extraMonitorIDs = [otherID];
        await code.approve(1, { ...job, projectID: v.projectID, password, confirm: true }, guard);
        const result = await run(v, job);
        assert.equal(result.status, readiness ? "succeeded" : "rollback_unhealthy");
        if (readiness) {
            const verified = JSON.parse(result.verification_json);
            assert.equal(verified.checks.length, 2);
            assert.ok(verified.checks.every((item) => item.observations.length === 2));
        }
    });
