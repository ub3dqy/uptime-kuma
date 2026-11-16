const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup, approve, run, password } = require("../fixtures/site-recovery-workspace.cjs");
const { guard } = require("../fixtures/project-workspace.cjs");
const recovery = require("../../server/projects/site-recovery");
const { validateDiagnosis } = require("../../server/projects/openai-client");
const { diagnosis } = require("../fixtures/openai-grant.cjs");
const Monitor = require("../../server/model/monitor");
const { UptimeKumaServer } = require("../../server/uptime-kuma-server");

test("fixed host actions use the existing personal project and SQL UTC incident; only owner may approve", async (t) => {
    const value = await setup(t, { personal: true });
    const { projectID, aiJobID } = value;
    const plan = await recovery.createPlan(value.ids.operator, { projectID, aiJobID }, guard);
    assert.equal(plan.status, "planned");
    assert.equal(
        value.host.calls.some((item) => ["backup", "apply"].includes(item.operation)),
        false
    );
    await assert.rejects(recovery.createPlan(value.ids.viewer, { projectID, aiJobID }, guard));
    await assert.rejects(recovery.createPlan(2, { projectID: value.otherID, aiJobID }, guard));
    await assert.rejects(
        recovery.approve(value.ids.admin, { ...plan, projectID, password, confirm: true }, guard),
        /projectRecoveryOwnerOnly/
    );
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID, password: "wrong", confirm: true }, guard),
        /projectRecoveryPassword/
    );
    await assert.rejects(recovery.approve(1, { ...plan, projectID, password, confirm: false }, guard));
    const queued = await recovery.approve(1, { ...plan, projectID, password, confirm: true }, guard);
    assert.equal(queued.id, (await recovery.approve(1, { ...plan, projectID, password, confirm: true }, guard)).id);
    assert.equal(value.host.calls.filter((item) => item.operation === "apply").length, 0);
    const schema = value.requests[0].text.format.schema.properties.remediation.properties.action.enum;
    assert.deepEqual(schema, ["none", "restart_service"]);
    assert.equal(JSON.stringify(value.preview).includes("private"), false);
});

test("verified indefinite backup precedes action; only two fresh same-session observations establish success", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    const result = await run(value, job);
    assert.equal(result.status, "succeeded");
    assert.equal(JSON.parse(result.backup_json).expiresAt, null);
    assert.equal(JSON.parse(result.verification_json).observations.length, 2);
    assert.deepEqual(
        value.host.calls.filter((item) => item.operation !== "inspect").map((item) => item.operation),
        ["backup", "apply"]
    );
    assert.equal(recovery.publicJob(result).canRollback, true);
});

test("two successes followed by an already recorded failure do not establish recovery", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    let clock = Date.now();
    let inserted = false;
    recovery.worker.now = () => clock;
    recovery.worker.sleep = async () => {
        const now = clock;
        clock += 25000;
        await recovery.worker.lease();
        if (inserted) return;
        inserted = true;
        await value.db("heartbeat").insert(
            [1, 1, 0].map((status, index) => ({
                monitor_id: value.monitorID,
                time: new Date(now + (index + 1) * 8000).toISOString(),
                status,
                check_interval: 20,
                check_session: "site-continuous-session",
            }))
        );
    };
    await recovery.worker.run(await value.db("project_site_recovery").where({ id: job.id }).first());
    const result = await value.db("project_site_recovery").where({ id: job.id }).first();
    assert.equal(result.status, "rollback_unhealthy");
    assert.equal(value.host.phase, "rolled_back");
});

test("a rejected or foreign monitor deletion leaves the running check alone", async (t) => {
    const value = await setup(t);
    await approve(value);
    const server = UptimeKumaServer.getInstance();
    const check = { stop: t.mock.fn() };
    server.monitorList[value.monitorID] = check;
    t.after(() => delete server.monitorList[value.monitorID]);

    const { user_id: ownerID } = await value.db("monitor").where({ id: value.monitorID }).first();
    await Monitor.deleteMonitor(value.monitorID, value.ids.viewer);
    await assert.rejects(Monitor.deleteMonitor(value.monitorID, ownerID), /FOREIGN KEY constraint failed/);
    assert.equal(check.stop.mock.callCount(), 0);
    assert.equal(server.monitorList[value.monitorID], check);
    assert.ok(await value.db("monitor").where({ id: value.monitorID }).first());
});

for (const mode of ["missing", "failed", "sessions", "cancel"])
    test(`${mode} never establishes recovery; compensation is verified separately and blocks another attempt`, async (t) => {
        const value = await setup(t);
        const result = await run(value, await approve(value), mode);
        assert.equal(result.status, "rollback_unhealthy");
        assert.equal(value.host.phase, "rolled_back");
        assert.equal(JSON.parse(result.rollback_json).healthy, false);
        assert.equal((await recovery.overview(1, value.projectID)).breakers.length, 1);
        assert.equal(value.host.calls.filter((item) => item.operation === "apply").length, 1);
    });

test("owner may request retained rollback; failed backup never permits a forward action", async (t) => {
    const value = await setup(t);
    const completed = await run(value, await approve(value));
    await recovery.rollback(
        1,
        { ...recovery.publicJob(completed), projectID: value.projectID, password, confirm: true },
        guard
    );
    const result = await run(value, completed);
    assert.equal(result.status, "rollback_unhealthy");
    assert.equal(value.host.calls.filter((item) => item.operation === "apply").length, 1);
});

test("expired plans, intervening successful observations and altered host policy fail closed", async (t) => {
    const value = await setup(t);
    const plan = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: value.aiJobID }, guard);
    value.host.policy = "f".repeat(64);
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID: value.projectID, password, confirm: true }, guard),
        /projectRecoveryDrift/
    );
    value.host.policy = "c".repeat(64);
    await value
        .db("project_site_recovery")
        .where({ id: plan.id })
        .update({ expires_at: Date.now() - 1 });
    await assert.rejects(
        recovery.approve(1, { ...plan, projectID: value.projectID, password, confirm: true }, guard),
        /projectRecoveryStale/
    );
    await value.db("heartbeat").insert({
        monitor_id: value.monitorID,
        status: 1,
        time: new Date().toISOString(),
        check_session: "site-continuous-session",
    });
    await value.db("heartbeat").insert({
        monitor_id: value.monitorID,
        status: 0,
        time: new Date().toISOString(),
        check_session: "site-continuous-session",
        msg: "HTTP 503",
    });
    await assert.rejects(
        recovery.createPlan(1, { projectID: value.projectID, aiJobID: value.aiJobID }, guard),
        /projectRecoveryStale/
    );
});

test("revoked owner and failed backup cannot start an action", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    await value.db("project_member").where({ project_id: value.projectID, user_id: 1 }).delete();
    const result = await run(value, job);
    assert.equal(result.status, "failed");
    assert.equal(
        value.host.calls.some((item) => item.operation === "backup"),
        false
    );
});

test("a second process cannot acquire a live database lease; stale leases can be recovered", async (t) => {
    const value = await setup(t);
    const second = new recovery.SiteRecoveryWorker();
    await second.start();
    clearInterval(second.timer);
    second.timer = null;
    assert.equal(second.ready, false);
    await value
        .db("project_site_recovery_worker")
        .where({ id: 1 })
        .update({ lease_until: Date.now() - 1 });
    assert.equal(await second.lease(), true);
    await assert.rejects(recovery.worker.ownsLease(), /projectRecoveryExecutor/);
    await second.stop();
});

test("model output cannot choose a different recipe or arbitrary action", () => {
    const output = (action) => ({ ...diagnosis, remediation: { action, reason: "Synthetic reason" } });
    assert.equal(validateDiagnosis(output("restart_service"), "restart_service").remediation.action, "restart_service");
    for (const action of ["restore_config", "restore_index", "run_shell", "restart_all"])
        assert.throws(() => validateDiagnosis(output(action), "restart_service"));
});

test("backup failure prevents apply and lost apply acknowledgement is compensated without replay", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    value.host.fail = "backup";
    const failed = await run(value, job);
    assert.equal(
        value.host.calls.some((item) => item.operation === "apply"),
        false
    );
    assert.notEqual(failed.status, "succeeded");
});

test("a lost response after application is recovered from root ledger and compensated once", async (t) => {
    const value = await setup(t, { host: { dropAfterApply: true } });
    const result = await run(value, await approve(value));
    assert.equal(result.status, "rollback_unhealthy");
    assert.equal(value.host.calls.filter((item) => item.operation === "apply").length, 1);
    assert.equal(value.host.calls.filter((item) => item.operation === "rollback").length, 1);
});

test("an interrupted executor compensates a durable applied action and never repeats it", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    value.host.phase = "applied";
    value.host.hash = "d".repeat(64);
    value.host.healthy = true;
    await value.db("project_site_recovery").where({ id: job.id }).update({ status: "applying" });
    const result = await run(value, job);
    assert.equal(result.status, "rollback_unhealthy");
    assert.equal(
        value.host.calls.some((item) => item.operation === "apply"),
        false
    );
});

test("recovery notices are reauthorized against exact current state and project revision", async (t) => {
    const value = await setup(t);
    const plan = await recovery.createPlan(1, { projectID: value.projectID, aiJobID: value.aiJobID }, guard);
    const scope = await value.db("project").where({ id: value.projectID }).first();
    const valid = require("../../server/notification-delivery").validSiteRecovery;
    const event = {
        user_id: scope.data_user_id,
        monitor_id: value.monitorID,
        event_key: `site-recovery:${value.projectID}:${plan.id}:planned`,
    };
    assert.equal(await valid(value.db, event, { projectID: value.projectID }), true);
    assert.equal(await valid(value.db, event, { projectID: value.otherID }), false);
    assert.equal(await valid(value.db, { ...event, user_id: 2 }, null), false);
    await value.db("project_site_recovery").where({ id: plan.id }).update({ status: "cancelled" });
    assert.equal(await valid(value.db, event, null), false);
});

test("cancelling a queued action records cancellation and never opens a host backup or mutation", async (t) => {
    const value = await setup(t);
    const job = await approve(value);
    await recovery.cancel(1, { projectID: value.projectID, id: job.id, revision: job.revision }, guard);
    const result = await run(value, job);
    assert.equal(result.status, "cancelled");
    assert.equal(
        value.host.calls.some((item) => ["backup", "apply"].includes(item.operation)),
        false
    );
});
