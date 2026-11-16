const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, guard } = require("../fixtures/project-workspace.cjs");
const automation = require("../../server/projects/ai-automation");
const ai = require("../../server/projects/ai-service");
const hash = require("../../server/password-hash");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
const password = "synthetic-automation-password-1234";

/**
 * @param {object} t Isolated test lifecycle
 * @returns {Promise<object>} Consenting owner and a verified synthetic connection
 */
async function setup(t) {
    const value = await fixture(t);
    await value
        .db("user")
        .where({ id: 1 })
        .update({ password: await hash.generate(password) });
    await value
        .db("project_ai")
        .where({ project_id: value.projectID })
        .update({
            mode: "api",
            state: "verified",
            model: "gpt-synthetic",
            daily_limit: 10,
            secret_cipher: require("../../server/projects/vault")
                .getVault()
                .seal(value.projectID, { api_key: "synthetic-only-no-network" }),
        });
    return value;
}
/**
 * @param {object} value Fixture
 * @param {number} status Saved state
 * @param {string} session Continuous observation identity
 * @returns {Promise<void>} A fresh ordered pair
 */
async function pair(value, status = 0, session = "same-run") {
    await value.db("heartbeat").where({ monitor_id: value.monitorID }).delete();
    await value.db("heartbeat").insert(
        [30, 10].map((age) => ({
            monitor_id: value.monitorID,
            status,
            time: new Date(Date.now() - age * 1000).toISOString(),
            check_interval: 20,
            check_session: session,
            ping: status ? 42 : null,
        }))
    );
}
/**
 * @param {object} value Fixture
 * @param {object} extra Policy overrides
 * @returns {Promise<object>} Saved explicit owner consent
 */
async function consent(value, extra = {}) {
    const settings = await automation.settings(1, value.projectID);
    return automation.save(
        1,
        {
            projectID: value.projectID,
            revision: settings.revision,
            enabled: true,
            consent: true,
            dailyLimit: 3,
            monitorIDs: [value.monitorID],
            currentPassword: password,
            ...extra,
        },
        guard
    );
}

test("automatic diagnosis needs current administrator password, data consent and a verified project connection", async (t) => {
    const value = await setup(t);
    const { projectID, ids, db } = value;
    const request = {
        projectID,
        revision: 0,
        enabled: true,
        consent: true,
        dailyLimit: 3,
        monitorIDs: [value.monitorID],
        currentPassword: password,
    };
    await assert.rejects(automation.save(ids.operator, request, guard), /projectAccessDenied/);
    await assert.rejects(
        automation.save(1, { ...request, currentPassword: "wrong" }, guard),
        /projectRecoveryPassword/
    );
    await assert.rejects(automation.save(1, { ...request, consent: false }, guard), /projectInvalid/);
    await db("project_ai").where({ project_id: projectID }).update({ state: "saved" });
    await assert.rejects(automation.save(1, request, guard), /projectAINeedProbe/);
    await db("project_ai").where({ project_id: projectID }).update({ state: "verified" });
    assert.equal((await consent(value)).active, true);
    await assert.rejects(automation.settings(ids.viewer, projectID), /projectAccessDenied/);
    assert.equal((await db("project_ai_job").count({ n: "id" }).first()).n, 0);
});

test("an incident is claimed once, survives restart and re-arms only after two continuous fresh successes", async (t) => {
    const value = await setup(t);
    await consent(value);
    await pair(value);
    const worker = new automation.AutomationWorker();
    await worker.scan();
    const first = await value.db("project_ai_job").first();
    assert.equal(first.trigger, "automatic");
    assert.equal(first.kind, "diagnosis");
    assert.equal(first.status, "queued");
    assert.equal(JSON.stringify(first).includes(password), false);
    await value.db("project_ai_job").where({ id: first.id }).update({ status: "uncertain" });
    await new automation.AutomationWorker().scan();
    await pair(value, 0, "after-restart");
    await worker.scan();
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 1);
    await pair(value, 1);
    await worker.scan();
    await pair(value, 0);
    await worker.scan();
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 2);
    assert.equal((await ai.jobs(1, value.projectID))[0].trigger, "automatic");
});

test("only selected checks are diagnosed; new legacy checks and excluded examples never expand saved consent", async (t) => {
    const value = await setup(t);
    const template = await value.db("monitor").where({ id: value.monitorID }).first();
    delete template.id;
    const [excludedID] = await value.db("monitor").insert({ ...template, name: "Excluded example" });
    await consent(value);
    const [addedID] = await value.db("monitor").insert({ ...template, name: "Added after consent" });
    for (const monitorID of [value.monitorID, excludedID, addedID]) await pair({ ...value, monitorID });
    const worker = new automation.AutomationWorker();
    await worker.scan();
    const first = await value.db("project_ai_job").first();
    assert.equal(first.monitor_id, value.monitorID);
    await value.db("project_ai_job").where({ id: first.id }).update({ status: "uncertain" });
    await new automation.AutomationWorker().scan();
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 1);
    assert.deepEqual((await automation.settings(1, value.projectID)).monitorIDs, [value.monitorID]);
    await consent(value, { monitorIDs: [excludedID] });
    await worker.scan();
    const second = await value.db("project_ai_job").orderBy("id", "desc").first();
    assert.equal(second.monitor_id, excludedID);
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 2);
});

test("selection rejects foreign checks, groups, duplicates and empty enabled scopes; corrupt saved selection fails closed", async (t) => {
    const value = await setup(t);
    const template = await value.db("monitor").where({ id: value.monitorID }).first();
    delete template.id;
    const foreignOwner = (await value.db("project").where({ id: value.otherID }).first()).data_user_id;
    const [foreignID] = await value.db("monitor").insert({ ...template, user_id: foreignOwner });
    const [groupID] = await value.db("monitor").insert({ ...template, type: "group" });
    for (const monitorIDs of [[foreignID], [groupID]])
        await assert.rejects(consent(value, { monitorIDs }), /projectAccessDenied/);
    for (const monitorIDs of [[], [value.monitorID, value.monitorID], [0], ["1"]]) {
        await assert.rejects(consent(value, { monitorIDs }), /projectInvalid/);
    }
    await consent(value);
    await pair(value);
    await value.db("project_ai_automation").where({ project_id: value.projectID }).update({ monitor_ids_json: "{" });
    await assert.rejects(automation.settings(1, value.projectID), /projectInvalid/);
    await new automation.AutomationWorker().scan();
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 0);
});

test("selected-check ownership is rechecked at claim and a removed selection cannot authorize an already queued job", async (t) => {
    const value = await setup(t);
    await consent(value);
    await pair(value);
    const worker = new automation.AutomationWorker();
    await worker.scan();
    const job = await value.db("project_ai_job").first();
    await value.db("project_ai_automation").where({ project_id: value.projectID }).update({ monitor_ids_json: "[]" });
    assert.equal((await automation.settings(1, value.projectID)).active, false);
    await assert.rejects(automation.validateJob(value.db, job, true), /projectAccessDenied/);
});

test("the upgrade pins legacy whole-project consent to its current checks and never broadens it later", async (t) => {
    const value = await setup(t);
    await value.db.schema.alterTable("project_ai_automation", (table) => table.dropColumn("monitor_ids_json"));
    const project = await value.db("project").where({ id: value.projectID }).first();
    const config = await value.db("project_ai").where({ project_id: value.projectID }).first();
    await value.db("project_ai_automation").insert({
        project_id: value.projectID,
        enabled: 1,
        authorized_by: 1,
        ai_revision: config.revision,
        project_revision: project.revision,
        daily_limit: 3,
        authorized_at: Date.now(),
        updated_at: Date.now(),
    });
    await require("../../db/knex_migrations/2026-11-02-0600-auto-diagnosis-scope").up(value.db);
    assert.deepEqual((await automation.settings(1, value.projectID)).monitorIDs, [value.monitorID]);
    const template = await value.db("monitor").where({ id: value.monitorID }).first();
    delete template.id;
    const [addedID] = await value.db("monitor").insert({ ...template, name: "Added after migration" });
    await pair({ ...value, monitorID: addedID });
    await new automation.AutomationWorker().scan();
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 0);
    await value.db("project_ai_automation").where({ project_id: value.projectID }).update({ monitor_ids_json: null });
    assert.equal((await automation.settings(1, value.projectID)).active, false);
    await new automation.AutomationWorker().scan();
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 0);
});

test("a revoked policy cancels queued work, old permission revisions are inactive, and automatic requests share the daily budget", async (t) => {
    const value = await setup(t);
    await consent(value, { dailyLimit: 1 });
    await pair(value);
    const worker = new automation.AutomationWorker();
    await worker.scan();
    const first = await value.db("project_ai_job").first();
    await consent(value, { enabled: false, consent: false });
    assert.equal((await value.db("project_ai_job").where({ id: first.id }).first()).status, "cancelled");
    await assert.rejects(automation.validateJob(value.db, first), /projectAccessDenied/);
    await consent(value, { dailyLimit: 1 });
    await pair(value, 1);
    await worker.scan();
    await pair(value, 0);
    await worker.scan();
    assert.equal((await value.db("project_ai_job").count({ n: "id" }).first()).n, 1);
    await value.db("project").where({ id: value.projectID }).increment("revision", 1);
    assert.equal((await automation.settings(1, value.projectID)).active, false);
    await assert.rejects(automation.validateJob(value.db, first), /projectAccessDenied/);
});

test("unknown, paused, old, missing and cross-session observations never trigger inference", () => {
    const now = Date.now();
    const monitor = { active: 1, interval: 20 };
    const beats = [30, 10].map((age) => ({
        status: 0,
        time: new Date(now - age * 1000).toISOString(),
        check_session: "same",
        check_interval: 20,
    }));
    assert.equal(automation.confirmedState(monitor, beats, now), "down");
    assert.equal(automation.confirmedState({ ...monitor, active: 0 }, beats, now), null);
    assert.equal(automation.confirmedState(monitor, beats, now + 180000), null);
    assert.equal(automation.confirmedState(monitor, [beats[0]], now), null);
    assert.equal(automation.confirmedState(monitor, [beats[0], { ...beats[1], check_session: "other" }], now), null);
    assert.equal(automation.confirmedState(monitor, [beats[0], { ...beats[1], status: 2 }], now), null);
});

test("current maintenance blocks claims and cancels an automatic job before inference even when old failures remain", async (t) => {
    const value = await setup(t);
    const { db, monitorID, projectID } = value;
    await consent(value);
    await pair(value);
    await db.schema.createTable("setting", (table) => {
        table.text("key").primary();
        table.text("value");
    });
    await db("setting").insert({ key: "serverTimezone", value: JSON.stringify("UTC") });
    await db.schema.createTable("maintenance", (table) => {
        table.increments("id");
        table.integer("active");
        for (const field of ["strategy", "start_date", "end_date", "timezone"]) table.text(field);
    });
    await db.schema.createTable("monitor_maintenance", (table) => {
        table.integer("monitor_id");
        table.integer("maintenance_id");
    });
    await db("maintenance").insert({ id: 777, active: 1, strategy: "manual" });
    await db("monitor_maintenance").insert({ monitor_id: monitorID, maintenance_id: 777 });
    const server = require("../../server/uptime-kuma-server").UptimeKumaServer.getInstance();
    server.maintenanceList[777] = {
        getStatus: require("../../server/model/maintenance").prototype.getStatus,
        beanMeta: {},
    };
    t.after(() => {
        delete server.maintenanceList[777];
    });
    const worker = new automation.AutomationWorker();
    await worker.scan();
    assert.equal((await db("project_ai_job").count({ n: "id" }).first()).n, 0);
    const originalTZ = process.env.TZ;
    const localTime = (epoch, timeZone) => {
        const parts = Object.fromEntries(
            new Intl.DateTimeFormat("en-GB", {
                timeZone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hourCycle: "h23",
            })
                .formatToParts(epoch)
                .map((part) => [part.type, part.value])
        );
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    };
    try {
        await db("setting")
            .where({ key: "serverTimezone" })
            .update({ value: JSON.stringify("Asia/Tokyo") });
        const monitor = await db("monitor").where({ id: monitorID }).first();
        const parents = new Map([[monitorID, monitor]]);
        for (const useEnvironment of [true, false]) {
            const timeZone = useEnvironment ? "America/Los_Angeles" : "Asia/Tokyo";
            if (useEnvironment) process.env.TZ = timeZone;
            else delete process.env.TZ;
            await db("maintenance")
                .where({ id: 777 })
                .update({
                    strategy: "single",
                    timezone: "SAME_AS_SERVER",
                    start_date: localTime(Date.now() - 300000, timeZone),
                    end_date: localTime(Date.now() + 300000, timeZone),
                });
            assert.equal(
                await automation.underMaintenance(db, monitor, parents),
                true,
                "The actual server timezone must control the maintenance window"
            );
        }
    } finally {
        if (originalTZ === undefined) delete process.env.TZ;
        else process.env.TZ = originalTZ;
        await db("maintenance").where({ id: 777 }).update({ strategy: "manual", start_date: null, end_date: null });
    }
    await db("maintenance").where({ id: 777 }).update({ active: 0 });
    await worker.scan();
    const job = await db("project_ai_job").where({ project_id: projectID }).first();
    assert.ok(job);
    await automation.validateJob(db, job, true);
    await db("maintenance").where({ id: 777 }).update({ active: 1 });
    await assert.rejects(automation.validateJob(db, job, true), /projectAccessDenied/);
});
