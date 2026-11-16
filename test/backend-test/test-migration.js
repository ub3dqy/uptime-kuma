const { describe, test } = require("node:test");
const fs = require("fs");
const path = require("path");
const { GenericContainer, Wait } = require("testcontainers");
const { MySqlContainer } = require("@testcontainers/mysql");
const checkClientGroups = require("./client-group-database-check.cjs");
const assert = require("node:assert/strict");

/**
 * @param {import("knex").Knex} db Isolated MySQL or MariaDB database.
 * @returns {Promise<void>} Resume the original failed migration and check large retained payloads.
 */
async function checkInterruptedRecoveryMigration(db) {
    const site = require("../../db/knex_migrations/2026-11-03-0000-site-recovery");
    const code = require("../../db/knex_migrations/2026-11-03-0100-code-recovery");
    await code.down(db);
    await db.schema.dropTable("project_site_recovery_worker");
    await db.schema.dropTable("project_site_recovery_target");
    await db.schema.alterTable("project_site_recovery", (table) => {
        for (const column of ["project_id", "monitor_id", "ai_job_id"]) table.dropForeign([column]);
        table.dropUnique(["ai_job_id"]);
        table.dropUnique(["remote_id"]);
        table.dropIndex(["project_id", "id"]);
        table.dropIndex(["status", "id"]);
    });
    await db.schema.alterTable("project_site_recovery", (table) => {
        for (const column of ["project_id", "monitor_id", "ai_job_id"]) table.integer(column).notNullable().alter();
    });
    await assert.rejects(db.schema.alterTable("project_site_recovery", (table) => {
        table.foreign("project_id").references("id").inTable("project").onDelete("CASCADE");
    }));
    await site.up(db);
    await site.up(db); // interrupted after DDL committed but before the migration was recorded
    await code.up(db);

    const [ownerID] = await db("user").insert({ username: "recovery-schema-owner" });
    await require("../../server/projects/store").ensurePersonalProject(ownerID);
    const personal = await db("project").where({ data_user_id: ownerID }).first();
    assert.equal(personal.allowed_ips_json, "[]");
    const projectID = personal.id;
    const [monitorID] = await db("monitor").insert({
        user_id: ownerID, name: "Owned", type: "http", method: "GET", conditions: "[]",
        accepted_statuscodes_json: "[\"200-299\"]",
    });
    const payload = "x".repeat(140000);
    const [aiJobID] = await db("project_ai_job").insert({
        project_id: projectID, user_id: ownerID, monitor_id: monitorID, revision: 1, project_revision: 1,
        kind: "code_patch", status: "completed", bucket_day: "2026-11-13", input_json: "{}", created_at: 1, updated_at: 1,
        code_input_cipher: payload, code_result_cipher: payload,
    });
    const job = {
        project_id: projectID, monitor_id: monitorID, ai_job_id: aiJobID, remote_id: "fixture", target_id: "fixture",
        status: "planned", created_by: ownerID, project_revision: 1, plan_json: "{}", plan_hash: "a".repeat(64),
        created_at: 1, expires_at: 2, updated_at: 1,
    };
    await db("project_site_recovery").insert(job);
    await assert.rejects(db("project_site_recovery").insert({ ...job, remote_id: "duplicate" }));
    await assert.rejects(db("monitor").where({ id: monitorID }).delete());
    const [codeID] = await db("project_code_recovery").insert({
        project_id: projectID, monitor_id: monitorID, target_id: "fixture", remote_id: "code", generation_id: aiJobID,
        created_by: ownerID, project_revision: 1, ai_revision: 1, status: "planned", source_hash: "a".repeat(64),
        source_cipher: payload, stage_json: payload, created_at: 1, updated_at: 1,
    });
    assert.equal((await db("project_ai_job").where({ id: aiJobID }).first()).code_input_cipher, payload);
    assert.equal((await db("project_code_recovery").where({ id: codeID }).first()).source_cipher, payload);
}

describe("Database Migration", () => {
    test("SQLite migrations run successfully from fresh database", async () => {
        const testDbPath = path.join(__dirname, "../../data/test-migration.db");
        const testDbDir = path.dirname(testDbPath);

        // Ensure data directory exists
        if (!fs.existsSync(testDbDir)) {
            fs.mkdirSync(testDbDir, { recursive: true });
        }

        // Clean up any existing test database
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }

        // Use the same SQLite driver as the project
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");

        const knex = require("knex");
        const db = knex({
            client: Dialect,
            connection: {
                filename: testDbPath,
            },
            useNullAsDefault: true,
        });

        // Setup R (redbean) with knex instance like production code does
        const { R } = require("redbean-node");
        R.setup(db);

        try {
            // Use production code to initialize SQLite tables (like first run)
            const { createTables } = require("../../db/knex_init_db.js");
            await createTables();

            // Run all migrations like production code does
            await R.knex.migrate.latest({
                directory: path.join(__dirname, "../../db/knex_migrations"),
            });

            await checkClientGroups();
        } finally {
            // Clean up
            await R.knex.destroy();
            if (fs.existsSync(testDbPath)) {
                fs.unlinkSync(testDbPath);
            }
        }
    });

    test(
        "MariaDB migrations run successfully from fresh database",
        {
            skip: !!process.env.CI && (process.platform !== "linux" || process.arch !== "x64"),
        },
        async () => {
            // Pin the database version so later image releases cannot change this test.
            const mariadbContainer = await new GenericContainer("mariadb:12.3.3")
                .withEnvironment({
                    MYSQL_ROOT_PASSWORD: "root",
                    MYSQL_DATABASE: "kuma_test",
                    MYSQL_USER: "kuma",
                    MYSQL_PASSWORD: "kuma",
                })
                .withExposedPorts(3306)
                .withWaitStrategy(Wait.forLogMessage("ready for connections", 2))
                .withStartupTimeout(120000)
                .start();

            // Wait a bit more to ensure MariaDB is fully ready
            await new Promise((resolve) => setTimeout(resolve, 2000));

            const knex = require("knex");
            const knexInstance = knex({
                client: "mysql2",
                connection: {
                    host: mariadbContainer.getHost(),
                    port: mariadbContainer.getMappedPort(3306),
                    user: "kuma",
                    password: "kuma",
                    database: "kuma_test",
                    timezone: "Z",
                    connectTimeout: 60000,
                },
                pool: {
                    min: 0,
                    max: 10,
                    acquireTimeoutMillis: 60000,
                    idleTimeoutMillis: 60000,
                },
            });

            // Setup R (redbean) with knex instance like production code does
            const { R } = require("redbean-node");
            R.setup(knexInstance);

            try {
                // Use production code to initialize MariaDB tables
                const { createTables } = require("../../db/knex_init_db.js");
                await createTables();
                await knexInstance("user").insert({ username: "existing-before-projects", active: 1 });

                // Run all migrations like production code does
                await R.knex.migrate.latest({
                    directory: path.join(__dirname, "../../db/knex_migrations"),
                });

                await checkClientGroups();
                assert.equal((await knexInstance("project").where({ name: "existing-before-projects" }).first()).allowed_ips_json, "[]");
                await checkInterruptedRecoveryMigration(knexInstance);
            } finally {
                // Clean up
                try {
                    await R.knex.destroy();
                } catch (e) {
                    // Ignore cleanup errors
                }
                try {
                    await mariadbContainer.stop();
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
    );

    test(
        "MySQL migrations run successfully from fresh database",
        {
            skip: !!process.env.CI && (process.platform !== "linux" || process.arch !== "x64"),
        },
        async () => {
            // Exercise the current MySQL 8.4 LTS line alongside MariaDB and SQLite.
            const mysqlContainer = await new MySqlContainer(
                "mysql:8.4@sha256:a0225d1ea6631c8bc2385dc4c2faba17bbf1834ecf369e1659a9a382bd8d5dd7"
            )
                .withStartupTimeout(120000)
                .start();

            const knex = require("knex");
            const knexInstance = knex({
                client: "mysql2",
                connection: {
                    host: mysqlContainer.getHost(),
                    port: mysqlContainer.getPort(),
                    user: mysqlContainer.getUsername(),
                    password: mysqlContainer.getUserPassword(),
                    database: mysqlContainer.getDatabase(),
                    timezone: "Z",
                    connectTimeout: 60000,
                },
                pool: {
                    min: 0,
                    max: 10,
                    acquireTimeoutMillis: 60000,
                    idleTimeoutMillis: 60000,
                },
            });

            // Setup R (redbean) with knex instance like production code does
            const { R } = require("redbean-node");
            R.setup(knexInstance);

            try {
                // Use production code to initialize MySQL tables
                const { createTables } = require("../../db/knex_init_db.js");
                await createTables();
                await knexInstance("user").insert({ username: "existing-before-projects", active: 1 });

                // Run all migrations like production code does
                await R.knex.migrate.latest({
                    directory: path.join(__dirname, "../../db/knex_migrations"),
                });

                await checkClientGroups();
                assert.equal((await knexInstance("project").where({ name: "existing-before-projects" }).first()).allowed_ips_json, "[]");
                await checkInterruptedRecoveryMigration(knexInstance);
            } finally {
                // Clean up
                try {
                    await R.knex.destroy();
                } catch (e) {
                    // Ignore cleanup errors
                }
                try {
                    await mysqlContainer.stop();
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
    );
});
