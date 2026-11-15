const assert = require("node:assert/strict");
const { R } = require("redbean-node");
const {
    saveClientGroup,
    listClientGroups,
    buildClientReport,
    deleteClientGroup,
} = require("../../server/client-groups");

/**
 * Exercise grouping and numeric history against the migrated real dialect.
 * @returns {Promise<void>} Cross-database transactions and foreign-key cleanup
 */
module.exports = async function checkClientGroups() {
    const [userID] = await R.knex("user").insert({ username: "client-migration-fixture" });
    const [monitorID] = await R.knex("monitor").insert({
        user_id: userID,
        name: "Database check",
        type: "http",
        active: 0,
        method: "GET",
        conditions: "[]",
        accepted_statuscodes_json: "[\"200-299\"]",
    });
    await R.knex("heartbeat").insert(
        ["2026-01-01 00:00:00", "2026-01-01 00:01:00"].map((time) => ({
            monitor_id: monitorID,
            time,
            status: 1,
            ping: 0,
            check_interval: 60,
            check_session: "database-fixture",
        }))
    );
    const client = await saveClientGroup(userID, { name: "Dialect fixture", monitorIDs: [monitorID] });
    assert.deepEqual((await listClientGroups(userID))[0].monitorIDs, [monitorID]);
    const report = await buildClientReport(userID, {
        ...client,
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-01T00:01:00.000Z",
    });
    assert.equal(report.totals.time.up, 60000);
    assert.equal(report.totals.time.unknown, 0);
    assert.equal(report.totals.availability, 1);
    assert.equal(report.monitors[0].summary.response.min, 0);
    const updated = await saveClientGroup(userID, { ...client, name: "Changed", monitorIDs: [monitorID] });
    await assert.rejects(saveClientGroup(userID, { ...client, name: "Stale", monitorIDs: [] }), /clientGroupChanged/);
    await deleteClientGroup(userID, updated);
    assert.equal((await R.knex("heartbeat").where({ monitor_id: monitorID })).length, 2);
    const next = await saveClientGroup(userID, { name: "Cascade", monitorIDs: [monitorID] });
    await R.knex("monitor").where({ id: monitorID }).delete();
    assert.deepEqual((await listClientGroups(userID))[0].monitorIDs, []);
    await deleteClientGroup(userID, next);
    await R.knex("user").where({ id: userID }).delete();
};
