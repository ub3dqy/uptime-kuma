exports.up = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => table.integer("max_response_time").nullable());
    await knex.schema.alterTable("notification", (table) =>
        table.integer("delivery_revision").notNullable().defaultTo(1)
    );
    await knex.schema.createTable("notification_delivery", (table) => {
        table.increments("id");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("user").onDelete("CASCADE");
        table
            .integer("notification_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("notification")
            .onDelete("CASCADE");
        table.integer("monitor_id").unsigned().nullable().references("id").inTable("monitor").onDelete("SET NULL");
        table.integer("revision").notNullable();
        table.string("kind", 24).notNullable();
        table.string("status", 24).notNullable();
        table.integer("attempts").notNullable().defaultTo(0);
        table.bigInteger("created_at").notNullable();
        table.bigInteger("updated_at").notNullable();
        table.bigInteger("next_attempt_at").notNullable();
        table.bigInteger("confirmed_at").nullable();
        table.string("error_code", 40).nullable();
        table.string("event_key", 160).notNullable();
        table.text("payload").notNullable();
        table.unique(["notification_id", "event_key"]);
        table.index(["status", "next_attempt_at"]);
        table.index(["user_id", "id"]);
        table.index(["notification_id", "id"]);
    });
};

exports.down = async (knex) => {
    await knex.schema.dropTable("notification_delivery");
    await knex.schema.alterTable("notification", (table) => table.dropColumn("delivery_revision"));
    await knex.schema.alterTable("monitor", (table) => table.dropColumn("max_response_time"));
};
