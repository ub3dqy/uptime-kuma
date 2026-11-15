exports.up = async (knex) => {
    await knex.schema.createTable("project_delivery_actor", (table) => {
        table
            .integer("delivery_id")
            .unsigned()
            .primary()
            .references("id")
            .inTable("notification_delivery")
            .onDelete("CASCADE");
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.integer("user_id").unsigned().nullable().references("id").inTable("user").onDelete("SET NULL");
        table.integer("project_revision").notNullable();
    });
};
exports.down = async (knex) => {
    await knex.schema.dropTable("project_delivery_actor");
};
