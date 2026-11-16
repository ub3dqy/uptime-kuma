exports.up = async function (knex) {
    await knex.schema.alterTable("project_ai_job", (table) => {
        // The permitted encrypted payload can exceed MySQL's 64 KiB TEXT limit.
        table.text("code_input_cipher", "mediumtext").nullable();
        table.text("code_result_cipher", "mediumtext").nullable();
    });
    await knex.schema.createTable("project_code_recovery", (table) => {
        table.increments("id");
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.integer("monitor_id").unsigned().notNullable().references("id").inTable("monitor").onDelete("RESTRICT");
        table.string("target_id", 40).notNullable();
        table.string("remote_id", 32).notNullable().unique();
        table.integer("generation_id").unsigned().nullable().references("id").inTable("project_ai_job").onDelete("RESTRICT");
        table.integer("review_id").unsigned().nullable().references("id").inTable("project_ai_job").onDelete("RESTRICT");
        table.integer("created_by").notNullable();
        table.integer("approved_by").nullable();
        table.bigInteger("approved_at").nullable();
        table.integer("project_revision").notNullable();
        table.integer("ai_revision").notNullable();
        table.string("status", 32).notNullable();
        table.integer("revision").notNullable().defaultTo(1);
        table.string("source_hash", 64).notNullable();
        table.text("source_cipher", "mediumtext").notNullable();
        table.text("plan_json", "mediumtext").nullable();
        table.string("plan_hash", 64).nullable();
        table.text("stage_json", "mediumtext").nullable();
        table.text("backup_json", "mediumtext").nullable();
        table.text("applied_json", "mediumtext").nullable();
        table.text("verification_json").nullable();
        table.text("rollback_json", "mediumtext").nullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("updated_at").notNullable();
        table.bigInteger("expires_at").nullable();
        table.bigInteger("finished_at").nullable();
        table.integer("cancel_requested").notNullable().defaultTo(0);
        table.string("error_code", 80).nullable();
        table.index(["project_id", "id"]);
        table.index(["status", "id"]);
    });
    await knex.schema.createTable("project_code_recovery_target", (table) => {
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.string("target_id", 40).notNullable();
        table.integer("open_id").nullable();
        table.bigInteger("blocked_at").nullable();
        table.bigInteger("last_action_at").nullable();
        table.primary(["project_id", "target_id"]);
    });
    await knex.schema.createTable("project_code_recovery_worker", (table) => {
        table.integer("id").primary();
        table.string("token", 64).notNullable();
        table.bigInteger("lease_until").notNullable();
    });
};

exports.down = async function (knex) {
    await knex.schema.dropTableIfExists("project_code_recovery_worker");
    await knex.schema.dropTableIfExists("project_code_recovery_target");
    await knex.schema.dropTableIfExists("project_code_recovery");
    await knex.schema.alterTable("project_ai_job", (table) => {
        table.dropColumn("code_input_cipher");
        table.dropColumn("code_result_cipher");
    });
};
