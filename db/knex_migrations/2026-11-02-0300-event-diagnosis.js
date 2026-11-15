exports.up = async (knex) => {
    await knex.schema.createTable("project_ai_automation", (t) => {
        t.integer("project_id").unsigned().primary().references("id").inTable("project").onDelete("RESTRICT");
        t.integer("revision").notNullable().defaultTo(1);
        t.integer("enabled").notNullable().defaultTo(0);
        t.integer("authorized_by").unsigned().nullable().references("id").inTable("user").onDelete("RESTRICT");
        t.integer("ai_revision").nullable();
        t.integer("project_revision").nullable();
        t.integer("daily_limit").notNullable().defaultTo(3);
        t.bigInteger("authorized_at").nullable();
        t.bigInteger("updated_at").notNullable();
    });
    await knex.schema.createTable("project_ai_incident", (t) => {
        t.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("RESTRICT");
        t.integer("monitor_id").unsigned().notNullable().references("id").inTable("monitor").onDelete("CASCADE");
        t.integer("armed").notNullable().defaultTo(1);
        t.bigInteger("last_job_id").nullable();
        t.bigInteger("updated_at").notNullable();
        t.primary(["project_id", "monitor_id"]);
    });
    await knex.schema.alterTable("project_ai_job", (t) => {
        t.string("trigger", 16).notNullable().defaultTo("manual");
        t.integer("automation_revision").nullable();
        t.index(["project_id", "bucket_day", "trigger"]);
    });
};

exports.down = async () => {
    throw new Error(
        "Restore the complete pre-update backup; automatic consent and incident deduplication must be retained."
    );
};
