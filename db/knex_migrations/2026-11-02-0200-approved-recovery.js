exports.up = async (knex) => {
    await knex.schema.createTable("project_recovery", (t) => {
        t.increments("id");
        t.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("RESTRICT");
        t.integer("monitor_id").unsigned().notNullable().references("id").inTable("monitor").onDelete("RESTRICT");
        t.integer("ai_job_id")
            .unsigned()
            .notNullable()
            .unique()
            .references("id")
            .inTable("project_ai_job")
            .onDelete("RESTRICT");
        t.integer("proposed_by").unsigned().notNullable().references("id").inTable("user").onDelete("RESTRICT");
        t.integer("approved_by").unsigned().nullable().references("id").inTable("user").onDelete("RESTRICT");
        t.string("target_id", 48).notNullable();
        t.string("status", 32).notNullable().defaultTo("planned");
        t.integer("revision").notNullable().defaultTo(1);
        t.integer("project_revision").notNullable();
        t.integer("ai_revision").notNullable();
        t.string("plan_hash", 64).notNullable();
        t.text("plan_json").notNullable();
        t.text("snapshot_cipher", "mediumtext").nullable();
        t.text("verification_json").nullable();
        t.text("rollback_verification_json").nullable();
        t.integer("cancel_requested").notNullable().defaultTo(0);
        t.string("reload_phase", 32).nullable();
        t.string("error_code", 48).nullable();
        for (const name of ["created_at", "updated_at", "expires_at"]) {
            t.bigInteger(name).notNullable();
        }
        for (const name of ["approved_at", "snapshot_at", "started_at", "applied_at", "rollback_at", "finished_at"]) {
            t.bigInteger(name).nullable();
        }
        t.index(["project_id", "id"]);
        t.index(["status", "id"]);
        t.index(["project_id", "target_id", "approved_at"]);
    });
    await knex.schema.createTable("project_recovery_target", (t) => {
        t.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("RESTRICT");
        t.string("target_id", 48).notNullable();
        t.integer("open_id").unsigned().nullable().references("id").inTable("project_recovery").onDelete("RESTRICT");
        t.bigInteger("blocked_at").nullable();
        t.string("reason", 48).nullable();
        t.primary(["project_id", "target_id"]);
    });
};

exports.down = async (knex) => {
    if (await knex("project_recovery").first()) {
        throw new Error(
            "Restore the pre-recovery backup; retained approvals and recovery points must not be discarded."
        );
    }
    await knex.schema.dropTable("project_recovery_target");
    await knex.schema.dropTable("project_recovery");
};
