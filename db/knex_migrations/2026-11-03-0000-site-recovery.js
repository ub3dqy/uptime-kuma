const jobReferences = [
    ["project_id", "project", "CASCADE"],
    ["monitor_id", "monitor", "RESTRICT"],
    ["ai_job_id", "project_ai_job", "RESTRICT"],
];

/**
 * @param {import("knex").Knex} knex Database connection.
 * @param {string} tableName Table left behind by an earlier failed migration.
 * @param {string[][]} references Expected references.
 * @returns {Promise<boolean>} Whether the existing table was repaired.
 */
async function repairIncompleteTable(knex, tableName, references) {
    if (knex.client.dialect !== "mysql" || !(await knex.schema.hasTable(tableName))) return false;

    // MySQL and MariaDB commit CREATE TABLE even if the subsequent ADD FOREIGN KEY fails.
    const columns = await knex("information_schema.KEY_COLUMN_USAGE")
        .select("COLUMN_NAME as column", "REFERENCED_TABLE_NAME as target", "REFERENCED_COLUMN_NAME as keyColumn")
        .where({ TABLE_NAME: tableName })
        .whereRaw("TABLE_SCHEMA = DATABASE()")
        .whereNotNull("REFERENCED_TABLE_NAME");
    for (const [column, target, onDelete] of references) {
        const existing = columns.filter((entry) => entry.column === column);
        if (existing.length) {
            if (existing.length !== 1 || existing[0].target !== target || existing[0].keyColumn !== "id") {
                throw new Error(`Unexpected foreign key for ${tableName}.${column}`);
            }
            continue;
        }
        await knex.schema.alterTable(tableName, (table) => table.integer(column).unsigned().notNullable().alter());
        await knex.schema.alterTable(tableName, (table) => table.foreign(column).references("id").inTable(target).onDelete(onDelete));
    }
    return true;
}

exports.up = async function (knex) {
    const jobs = "project_site_recovery";
    const indexes = [
        { columns: ["ai_job_id"], unique: true },
        { columns: ["remote_id"], unique: true },
        { columns: ["project_id", "id"] },
        { columns: ["status", "id"] },
    ].map((entry) => ({ ...entry, name: `${jobs}_${entry.columns.join("_")}_${entry.unique ? "unique" : "index"}` }));
    if (await repairIncompleteTable(knex, jobs, jobReferences)) {
        const existing = await knex("information_schema.STATISTICS")
            .distinct("INDEX_NAME as name")
            .where({ TABLE_NAME: jobs })
            .whereRaw("TABLE_SCHEMA = DATABASE()");
        const missing = indexes.filter(({ name }) => !existing.some((entry) => entry.name === name));
        if (missing.length) {
            await knex.schema.alterTable(jobs, (table) => {
                for (const { columns, name, unique } of missing) {
                    if (unique) table.unique(columns, { indexName: name });
                    else table.index(columns, name);
                }
            });
        }
    } else {
        await knex.schema.createTable(jobs, (table) => {
            table.increments("id");
            for (const [column, target, onDelete] of jobReferences) {
                table.integer(column).unsigned().notNullable().references("id").inTable(target).onDelete(onDelete);
            }
            table.string("target_id", 40).notNullable();
            table.string("remote_id", 32).notNullable();
            table.string("status", 32).notNullable();
            table.integer("revision").notNullable().defaultTo(1);
            table.integer("created_by").notNullable();
            table.integer("approved_by").nullable();
            table.bigInteger("approved_at").nullable();
            table.integer("project_revision").notNullable();
            table.text("plan_json").notNullable();
            table.string("plan_hash", 64).notNullable();
            table.bigInteger("created_at").notNullable();
            table.bigInteger("expires_at").notNullable();
            table.bigInteger("updated_at").notNullable();
            table.bigInteger("finished_at").nullable();
            table.integer("cancel_requested").notNullable().defaultTo(0);
            table.text("backup_json").nullable();
            table.text("applied_json").nullable();
            table.text("verification_json").nullable();
            table.text("rollback_json").nullable();
            table.string("error_code", 80).nullable();
            for (const { columns, name, unique } of indexes) {
                if (unique) table.unique(columns, { indexName: name });
                else table.index(columns, name);
            }
        });
    }
    if (!(await repairIncompleteTable(knex, "project_site_recovery_target", [jobReferences[0]]))) {
        await knex.schema.createTable("project_site_recovery_target", (table) => {
            table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
            table.string("target_id", 40).notNullable();
            table.integer("open_id").nullable();
            table.bigInteger("blocked_at").nullable();
            table.bigInteger("last_action_at").nullable();
            table.primary(["project_id", "target_id"]);
        });
    }
    if (knex.client.dialect !== "mysql" || !(await knex.schema.hasTable("project_site_recovery_worker"))) {
        await knex.schema.createTable("project_site_recovery_worker", (table) => {
            table.integer("id").primary();
            table.string("token", 64).notNullable();
            table.bigInteger("lease_until").notNullable();
        });
    }
};

exports.down = async function (knex) {
    await knex.schema.dropTableIfExists("project_site_recovery_worker");
    await knex.schema.dropTableIfExists("project_site_recovery_target");
    await knex.schema.dropTableIfExists("project_site_recovery");
};
