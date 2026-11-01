exports.up = async (knex) => {
    await knex.schema.createTable("client_group", (table) => {
        table.increments("id");
        table
            .integer("user_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("user")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.string("name", 120).notNullable();
        table.integer("revision").unsigned().notNullable().defaultTo(1);
        table.index("user_id");
    });
    await knex.schema.createTable("client_group_monitor", (table) => {
        table
            .integer("client_group_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("client_group")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table
            .integer("monitor_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.primary(["client_group_id", "monitor_id"]);
        table.index("monitor_id");
    });
};

exports.down = async (knex) => {
    await knex.schema.dropTable("client_group_monitor");
    await knex.schema.dropTable("client_group");
};
