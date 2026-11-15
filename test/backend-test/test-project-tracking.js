const { test } = require("node:test");
const assert = require("node:assert/strict");
const { latencyTrend } = require("../../src/monitor-tracking.ts");
const tracking = require("../../server/projects/tracking");
const store = require("../../server/projects/store");
const { fixture, guard } = require("../fixtures/project-workspace.cjs");
test("latency advisory needs continuous fresh successes and never treats missing values or outages as a trend", () => {
    const now = Date.now();
    const monitor = { active: 1, interval: 20 };
    const beats = Array.from({ length: 15 }, (_, index) => ({
        time: new Date(now - (15 - index) * 20000).toISOString(),
        ping: index < 10 ? 100 : 250,
        status: 1,
        check_session: "one",
        check_interval: 20,
    }));
    assert.deepEqual(latencyTrend(monitor, beats, now), { state: "increased", before: 100, recent: 250, samples: 15 });
    assert.equal(latencyTrend({ ...monitor, active: 0 }, beats, now).state, "insufficient");
    for (const change of [
        { ping: null },
        { status: 0 },
        { check_session: "another" },
        { time: new Date(now - 9999999).toISOString() },
    ]) {
        const changed = beats.map((beat, index) => (index === 10 ? { ...beat, ...change } : beat));
        assert.equal(latencyTrend(monitor, changed, now).state, "insufficient");
    }
});
test("dependency links are scoped, acyclic, permission-checked and cannot alter monitoring results", async (t) => {
    const value = await fixture(t);
    const { db, projectID, monitorID, ids } = value;
    const nextID = await store.saveMonitor(
        1,
        { projectID, name: "Dependency", type: "http", url: "http://127.0.0.1:1/", interval: 20, maxretries: 0 },
        guard
    );
    let revision = (await db("project").where({ id: projectID }).first()).revision;
    const request = { projectID, monitorID, dependencies: [nextID], revision };
    await assert.rejects(tracking.save(ids.viewer, request, guard), /projectAccessDenied/);
    await assert.rejects(tracking.save(2, request, guard), /projectAccessDenied/);
    await tracking.save(ids.operator, request, guard);
    revision++;
    await assert.rejects(
        tracking.save(1, { projectID, monitorID: nextID, dependencies: [monitorID], revision }, guard),
        /projectDependencyCycle/
    );
    await assert.rejects(
        tracking.save(1, { projectID, monitorID, dependencies: [999999], revision }, guard),
        /projectAccessDenied/
    );
    assert.deepEqual(
        (await tracking.overview(ids.viewer, { projectID })).monitors.find((monitor) => monitor.id === monitorID)
            .dependencies,
        [nextID]
    );
    assert.equal((await db("monitor").where({ id: monitorID }).first()).active, 1);
    assert.equal((await db("heartbeat").count({ n: "id" }).first()).n, 0);
    assert.equal((await db("notification").count({ n: "id" }).first()).n, 0);
});
