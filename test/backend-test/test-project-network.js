const { test } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns");
const { ProjectNetworkPolicy } = require("../../server/projects/network-policy");
const { fixture, guard } = require("../fixtures/project-workspace.cjs");
const { saveManagedChannel, requestTest, DeliveryQueue } = require("../../server/notification-delivery");

test("project network policy blocks private, reserved, IPv6 and mapped loopback targets unless the exact IPv4 is approved", async () => {
    const policy = new ProjectNetworkPolicy();
    for (const address of [
        "127.0.0.1",
        "0.0.0.0",
        "10.1.2.3",
        "172.16.1.2",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.1.1",
        "192.0.2.1",
        "198.18.1.1",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::ffff:127.0.0.1",
    ]) {
        assert.equal(policy.permits(address), false, address);
        await assert.rejects(policy.addresses(address), /PROJECT_TARGET_BLOCKED/);
        assert.throws(() => policy.checkLiteral(address), /PROJECT_TARGET_BLOCKED/);
    }
    assert.equal(policy.permits("1.1.1.1"), true);
    const approved = new ProjectNetworkPolicy(["127.0.0.1"]);
    assert.deepEqual(await approved.addresses("127.0.0.1"), ["127.0.0.1"]);
    await assert.rejects(approved.addresses("127.0.0.2"), /PROJECT_TARGET_BLOCKED/);
});

test("connection-time lookup filters private answers, pins the returned address and refuses rebinding", async (t) => {
    let calls = 0;
    t.mock.method(dns.promises, "lookup", async () => {
        calls++;
        return calls === 1
            ? [
                  { address: "1.1.1.1", family: 4 },
                  { address: "127.0.0.1", family: 4 },
              ]
            : [{ address: "127.0.0.1", family: 4 }];
    });
    const policy = new ProjectNetworkPolicy();
    const value = await new Promise((resolve, reject) =>
        policy.lookup("synthetic.example", { all: true }, (error, addresses) =>
            error ? reject(error) : resolve(addresses)
        )
    );
    assert.deepEqual(value, [{ address: "1.1.1.1", family: 4 }]);
    await assert.rejects(policy.addresses("synthetic.example"), /PROJECT_TARGET_BLOCKED/);
});

test("SMTP rechecks channel revision after asynchronous target resolution and never sends a stale message", async (t) => {
    const { db, projectID, monitorID } = await fixture(t);
    const owner = (await db("project").where({ id: projectID }).first()).data_user_id;
    const id = await saveManagedChannel(
        owner,
        {
            config: {
                type: "smtp",
                name: "Protected channel",
                smtpHost: "synthetic.example",
                smtpPort: 465,
                smtpSecure: true,
                smtpFrom: "a@example.test",
                smtpTo: "b@example.test",
                smtpPassword: "synthetic-password",
                locale: "en",
            },
            monitorIDs: [monitorID],
        },
        guard,
        projectID
    );
    await requestTest(owner, { id, revision: 1 }, guard, { projectID, userID: 1 });
    const sent = [];
    t.mock.method(ProjectNetworkPolicy.prototype, "addresses", async () => {
        await db("notification").where({ id }).increment("delivery_revision", 1);
        return ["127.0.0.1"];
    });
    const worker = new DeliveryQueue({
        db,
        now: () => Date.now() + 100,
        send: async (...args) => sent.push(args),
        isUnderMaintenance: async () => false,
    });
    await worker.tick();
    assert.equal(sent.length, 0);
    assert.equal((await db("notification_delivery").where({ notification_id: id }).first()).status, "cancelled");
});

test("a queued project test is cancelled after its initiating administrator loses access", async (t) => {
    const { db, projectID, monitorID } = await fixture(t);
    const owner = (await db("project").where({ id: projectID }).first()).data_user_id;
    const id = await saveManagedChannel(
        owner,
        {
            config: {
                type: "smtp",
                name: "Role-bound test",
                smtpHost: "127.0.0.1",
                smtpPort: 465,
                smtpSecure: true,
                smtpFrom: "a@example.test",
                smtpTo: "b@example.test",
                locale: "en",
            },
            monitorIDs: [monitorID],
        },
        guard,
        projectID
    );
    const jobID = await requestTest(owner, { id, revision: 1 }, guard, { projectID, userID: 1 });
    assert.equal((await db("project_delivery_actor").where({ delivery_id: jobID }).first()).user_id, 1);
    await db("project_member").where({ project_id: projectID, user_id: 1 }).delete();
    const sent = [];
    const worker = new DeliveryQueue({
        db,
        now: () => Date.now() + 100,
        send: async (...args) => sent.push(args),
        isUnderMaintenance: async () => false,
    });
    await worker.tick();
    assert.equal(sent.length, 0);
    assert.equal((await db("notification_delivery").where({ id: jobID }).first()).status, "cancelled");
});
