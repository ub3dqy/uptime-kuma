exports.up = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.text("browser_steps_json").nullable();
        table.boolean("witness_site").notNullable().defaultTo(false);
    });
    await knex.schema.createTable("browser_journey_result", (table) => {
        table.integer("monitor_id").unsigned().primary().references("id").inTable("monitor").onDelete("CASCADE");
        table.string("configuration", 64).notNullable();
        table.bigInteger("checked_at").notNullable();
        table.integer("failed_step").nullable();
        table.text("screenshot", "mediumtext").nullable();
    });
    await knex.schema.createTable("witness_site_result", (table) => {
        table.integer("monitor_id").unsigned().primary().references("id").inTable("monitor").onDelete("CASCADE");
        table.string("node_id", 48).notNullable();
        table.string("config_hash", 64).notNullable();
        table.string("target_hash", 64).notNullable();
        table.bigInteger("checked_at").notNullable();
        table.integer("http_status").nullable();
        table.integer("response_ms").nullable();
    });
};

exports.down = async (knex) => {
    await knex.schema.dropTable("witness_site_result");
    await knex.schema.dropTable("browser_journey_result");
    await knex.schema.alterTable("monitor", (table) => table.dropColumns("browser_steps_json", "witness_site"));
};
