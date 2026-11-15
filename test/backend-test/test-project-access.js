const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, guard } = require("../fixtures/project-workspace.cjs");
const store = require("../../server/projects/store");
const { permit, installProjectGate } = require("../../server/projects/access");
const auth = require("../../server/auth");
const migration = require("../../db/knex_migrations/2026-11-02-0000-projects-personal-ai");

test("project roles enforce object ownership and never activate legacy administrator accounts", async (t) => {
    const { db, projectID, otherID, ids, monitorID } = await fixture(t);
    assert.equal((await store.listProjects(ids.viewer)).length, 1);
    await permit(ids.viewer, projectID);
    let policyScope = await permit(1, projectID, "admin");
    const update = {
        projectID,
        revision: policyScope.revision,
        name: policyScope.name,
        timezone: policyScope.timezone,
        allowedIPs: ["127.0.0.2"],
    };
    await assert.rejects(store.updateProject(ids.admin, update, guard), /projectAccessDenied/);
    await store.updateProject(1, update, guard);
    assert.deepEqual(JSON.parse((await db("project").where({ id: projectID }).first()).allowed_ips_json), [
        "127.0.0.2",
    ]);
    assert.equal(
        Object.hasOwn((await store.projectSnapshot(ids.viewer, projectID)).project, "allowedIPs") &&
            (await store.projectSnapshot(ids.viewer, projectID)).project.allowedIPs !== undefined,
        false
    );
    await assert.rejects(permit(ids.viewer, otherID), /projectAccessDenied/);
    await assert.rejects(permit(ids.viewer, projectID, "operator"), /projectAccessDenied/);
    await assert.rejects(store.monitorEditor(ids.viewer, { projectID, id: monitorID }), /projectAccessDenied/);
    await assert.rejects(store.monitorEditor(ids.operator, { projectID: otherID, id: monitorID }));
    await assert.rejects(store.controlMonitor(ids.viewer, { projectID, id: monitorID, action: "pause" }, guard));
    await store.controlMonitor(ids.operator, { projectID, id: monitorID, action: "pause" }, guard);
    assert.equal((await db("monitor").where({ id: monitorID }).first()).active, 0);
    const participant = await auth.login("viewer", "synthetic-password-1234");
    assert.equal(participant.id, ids.viewer);
    assert.equal(participant.active, 0);
    assert.notEqual(auth.passwordFor(participant), participant.password);
    assert.equal(await db("user").where({ id: ids.viewer, active: 1 }).first(), undefined);
    const technical = await db("user").where({ service_account: 1 }).first();
    assert.equal(await auth.findHumanByID(technical.id), null);
    await assert.rejects(migration.down(db), /Restore the pre-project backup/);
    await db("project_identity").where({ user_id: ids.viewer }).update({ active: 0 });
    assert.equal(await auth.login("viewer", "synthetic-password-1234"), null);
    await assert.rejects(permit(ids.viewer, projectID));
});

test("socket gate closes legacy reads and writes for invited users, including disabled identities", async (t) => {
    const { db, ids } = await fixture(t);
    let middleware;
    const socket = {
        userID: ids.viewer,
        use: (fn) => {
            middleware = fn;
        },
    };
    installProjectGate(socket);
    for (const event of [
        "getSettings",
        "getMonitorList",
        "getNotificationList",
        "add",
        "deleteMonitor",
        "setSettings",
        "getDockerHostList",
        "getAPIKeyList",
    ]) {
        let passed = false;
        let answer;
        await middleware(
            [
                event,
                {},
                (value) => {
                    answer = value;
                },
            ],
            () => {
                passed = true;
            }
        );
        assert.equal(passed, false, event);
        assert.equal(answer.msg, "projectAccessDenied", event);
    }
    let passed = false;
    await middleware(["projectSnapshot", {}], () => {
        passed = true;
    });
    assert.equal(passed, true); // Its own handler then checks membership and object ownership.
    await db("project_identity").where({ user_id: ids.viewer }).update({ active: 0 });
    passed = false;
    await middleware(["changePassword", {}, () => {}], () => {
        passed = true;
    });
    assert.equal(passed, false);
    socket.userID = 1;
    socket.projectGeneration = 1;
    let stale;
    const packet = [
        "getSettings",
        (reply) => {
            stale = reply;
        },
    ];
    await middleware(packet, () => {});
    socket.projectGeneration = 2;
    packet[1]({ ok: true, private: "old-settings" });
    assert.equal(stale.msg, "projectAccessDenied");
    assert.equal(Object.hasOwn(stale, "private"), false);
});

test("invitations are hashed, single-use, expiring, revocable and bound to a current administrator", async (t) => {
    const { db, projectID, ids } = await fixture(t);
    const invitation = await store.invite(1, { projectID, role: "viewer" }, guard);
    assert.equal(JSON.stringify(await db("project_invite")).includes(invitation.token), false);
    await store.acceptInvite(ids.operator, { token: invitation.token }, guard);
    assert.equal((await permit(ids.operator, projectID)).role, "operator"); // Joining cannot silently elevate/demote.
    await assert.rejects(store.acceptInvite(2, { token: invitation.token }, guard), /projectInviteInvalid/);
    const expired = await store.invite(1, { projectID, role: "viewer" }, guard);
    await db("project_invite")
        .whereNull("used_at")
        .update({ expires_at: Date.now() - 1 });
    await assert.rejects(store.inviteInfo(expired.token), /projectInviteInvalid/);
    const revoked = await store.invite(1, { projectID, role: "viewer" }, guard);
    const record = await db("project_invite").whereNull("used_at").where("expires_at", ">", Date.now()).first();
    await store.revokeInvite(1, { projectID, id: record.id }, guard);
    await assert.rejects(store.inviteInfo(revoked.token), /projectInviteInvalid/);
    const stale = await store.invite(ids.admin, { projectID, role: "admin" }, guard);
    const scope = await permit(1, projectID, "admin");
    await store.changeMember(1, { projectID, userID: ids.admin, role: "viewer", revision: scope.revision }, guard);
    await assert.rejects(store.inviteInfo(stale.token), /projectInviteInvalid/);
    for (const role of ["__proto__", "constructor", {}, 3]) {
        await assert.rejects(store.invite(1, { projectID, role }, guard));
    }
});

test("last administrator, personal owner, stale edits and lost sessions are protected atomically", async (t) => {
    const { db, projectID, ids } = await fixture(t);
    let scope = await permit(1, projectID, "admin");
    await store.changeMember(1, { projectID, userID: ids.admin, role: null, revision: scope.revision }, guard);
    scope = await permit(1, projectID, "admin");
    await assert.rejects(
        store.changeMember(1, { projectID, userID: 1, role: "viewer", revision: scope.revision }, guard),
        /projectLastAdmin/
    );
    const personal = await db("project").where({ data_user_id: 1 }).first();
    await assert.rejects(
        store.changeMember(1, { projectID: personal.id, userID: 1, role: null, revision: personal.revision }, guard),
        /projectPersonalOwner/
    );
    const before = await db("project").where({ id: projectID }).first();
    await assert.rejects(
        store.updateProject(
            1,
            { projectID, revision: before.revision, name: "Rolled back", timezone: "UTC" },
            async () => {
                throw new Error("session-changed");
            }
        )
    );
    assert.equal((await db("project").where({ id: projectID }).first()).name, before.name);
    await assert.rejects(
        store.updateProject(1, { projectID, revision: 0, name: "Stale", timezone: "UTC" }, guard),
        /projectChanged/
    );
    await assert.rejects(store.createProject(ids.admin, { name: "Forbidden", allowedIPs: ["127.0.0.1"] }, guard));
});

test("project snapshot batches history, sanitizes messages and never returns target credentials", async (t) => {
    const { db, projectID, ids, monitorID } = await fixture(t);
    const rows = Array.from({ length: 35 }, (_, index) => ({
        monitor_id: monitorID,
        time: new Date(Date.now() - (35 - index) * 20000).toISOString(),
        status: 0,
        ping: index,
        check_interval: 20,
        check_session: "test-run",
        msg: "HTTP 404 private-credential",
        response: "private-response",
    }));
    await db("heartbeat").insert(rows);
    const snapshot = await store.projectSnapshot(ids.viewer, projectID);
    assert.equal(snapshot.monitors[0].observations.length, 30);
    assert.equal(snapshot.monitors[0].observations.at(-1).ping, 34);
    await db("heartbeat").insert({ ...rows.at(-1), ping: 999, status: 1 });
    const equalTime = await store.projectSnapshot(ids.viewer, projectID);
    assert.equal(equalTime.monitors[0].observations.at(-1).ping, 999);
    const output = JSON.stringify(snapshot);
    for (const secret of ["never-share", "private-credential", "private-response", "push_token", "secret_cipher"]) {
        assert.equal(output.includes(secret), false, secret);
    }
    assert.equal(snapshot.project.role, "viewer");
});

test("restricted checks reject unsafe JSON expressions, resolver names, credentials and mixed ownership", async (t) => {
    const { projectID, otherID, ids } = await fixture(t);
    const base = { projectID, name: "Check", interval: 20, type: "http", url: "https://example.test" };
    await assert.rejects(store.saveMonitor(ids.operator, { ...base, projectID: otherID }, guard));
    await assert.rejects(store.saveMonitor(1, { ...base, url: "https://user:secret@example.test" }, guard));
    await assert.rejects(
        store.saveMonitor(1, { ...base, type: "dns", hostname: "example.test", dnsServer: "internal.local" }, guard)
    );
    await assert.rejects(
        store.saveMonitor(
            1,
            { ...base, type: "json-query", jsonPath: "$eval('arbitrary')", expectedValue: "up" },
            guard
        )
    );
    await store.saveMonitor(
        ids.operator,
        { ...base, type: "json-query", jsonPath: "services[0].state", expectedValue: "up" },
        guard
    );
});
