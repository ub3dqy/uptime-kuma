const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { R } = require("redbean-node");
const store = require("../../server/projects/store");
const migration = require("../../db/knex_migrations/2026-11-02-0000-projects-personal-ai");

/** @returns {Promise<void>} A test-owned identity remains valid */
async function guard() {}

/**
 * Real SQLite constraints and migrations, with retained private key artifacts.
 * @param {object} context Test lifecycle
 * @returns {Promise<object>} Isolated project, roles and two owners
 */
async function fixture(context) {
    const Dialect = require("knex/lib/dialects/sqlite3");
    Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
    const db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
    context.after(async () => {
        const site = require.cache[require.resolve("../../server/projects/site-recovery")]?.exports;
        if (site?.worker.token) await site.worker.stop();
        const code = require.cache[require.resolve("../../server/projects/code-recovery")]?.exports;
        if (code?.worker.token) await code.worker.stop();
        await db.destroy();
    });
    R.setup(db);
    await db.raw("PRAGMA foreign_keys=ON");
    await db.schema.createTable("user", (t) => {
        t.increments("id");
        t.text("username").unique();
        t.text("password");
        t.integer("active").defaultTo(1);
        t.integer("twofa_status").defaultTo(0);
        t.text("twofa_secret");
        t.text("twofa_last_token");
    });
    await db.schema.createTable("monitor", (t) => {
        t.increments("id");
        t.integer("user_id").references("id").inTable("user");
        for (const name of [
            "name",
            "type",
            "url",
            "hostname",
            "method",
            "accepted_statuscodes_json",
            "keyword",
            "json_path",
            "expected_value",
            "json_path_operator",
            "dns_resolve_type",
            "dns_resolve_server",
            "push_token",
            "kafka_producer_brokers",
            "kafka_producer_sasl_options",
            "rabbitmq_nodes",
            "conditions",
        ]) {
            t.text(name);
        }
        for (const name of [
            "parent",
            "port",
            "interval",
            "retry_interval",
            "maxretries",
            "timeout",
            "maxredirects",
            "expiry_notification",
            "domain_expiry_notification",
            "ignore_tls",
            "upside_down",
            "resend_interval",
        ]) {
            t.integer(name);
        }
        t.integer("active").defaultTo(1);
    });
    await db.schema.createTable("heartbeat", (t) => {
        t.increments("id");
        t.integer("monitor_id").references("id").inTable("monitor");
        t.text("time");
        t.integer("status");
        t.float("ping");
        t.text("msg");
        t.text("response");
        t.double("check_interval");
        t.text("check_session");
    });
    await db.schema.createTable("notification", (t) => {
        t.increments("id");
        t.integer("user_id");
        t.text("name");
        t.text("config");
        t.integer("active").defaultTo(1);
        t.integer("is_default").defaultTo(0);
    });
    await db.schema.createTable("monitor_notification", (t) => {
        t.integer("monitor_id");
        t.integer("notification_id").references("id").inTable("notification").onDelete("CASCADE");
        t.primary(["monitor_id", "notification_id"]);
    });
    await db("user").insert([
        { id: 1, username: "owner", password: "unusable-test-password" },
        { id: 2, username: "other", password: "unusable-test-password" },
    ]);
    await require("../../db/knex_migrations/2026-11-01-0300-monitor-alert-workflow").up(db);
    await migration.up(db);
    await require("../../db/knex_migrations/2026-11-02-0100-project-alert-actors").up(db);
    await require("../../db/knex_migrations/2026-11-02-0200-approved-recovery").up(db);
    await require("../../db/knex_migrations/2026-11-02-0300-event-diagnosis").up(db);
    await require("../../db/knex_migrations/2026-11-02-0400-independent-witness").up(db);
    await require("../../db/knex_migrations/2026-11-02-0500-monitor-dependencies").up(db);
    await require("../../db/knex_migrations/2026-11-02-0600-auto-diagnosis-scope").up(db);
    await require("../../db/knex_migrations/2026-11-03-0000-site-recovery").up(db);
    await require("../../db/knex_migrations/2026-11-03-0100-code-recovery").up(db);
    await require("../../db/knex_migrations/2026-11-16-0000-monitor-alert-rules").up(db);
    await require("../../db/knex_migrations/2026-11-16-0100-add-browser-journeys-and-witness-sites").up(db);
    const folder = path.resolve(__dirname, "../../private", "project-tests-" + randomBytes(8).toString("hex"));
    fs.mkdirSync(path.dirname(folder), { recursive: true, mode: 0o700 });
    fs.mkdirSync(folder, { mode: 0o700 });
    process.env.UPTIME_KUMA_PROJECT_KEY_FILE = path.join(folder, "vault", "keys.json");
    await require("../../server/projects/vault").initializeVaultState(db);
    const projectID = await store.createProject(
        1,
        { name: "First project", timezone: "Europe/Moscow", allowedIPs: ["127.0.0.1"] },
        guard
    );
    const otherID = await store.createProject(2, { name: "Unrelated project" }, guard);
    const ids = {};
    for (const role of ["viewer", "operator", "admin"]) {
        const invitation = await store.invite(1, { projectID, role }, guard);
        await store.acceptInvite(
            null,
            { token: invitation.token, username: role, password: "synthetic-password-1234" },
            guard
        );
        ids[role] = (await db("user").where({ username: role }).first()).id;
    }
    const monitorID = await store.saveMonitor(
        1,
        {
            projectID,
            name: "Synthetic service",
            type: "http",
            url: "http://127.0.0.1:1/?secret=never-share",
            interval: 20,
            maxretries: 0,
        },
        guard
    );
    return { db, projectID, otherID, monitorID, ids, folder };
}

module.exports = { fixture, guard };
