exports.up = async (knex) => {
    await knex.schema.createTable("monitor_alert_rule", (table) => {
        table.integer("monitor_id").unsigned().primary().references("id").inTable("monitor").onDelete("CASCADE");
        table.string("revision", 36).notNullable();
        table
            .integer("telegram_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("notification")
            .onDelete("CASCADE");
        table.integer("telegram_revision").notNullable();
        table.integer("email_id").unsigned().notNullable().references("id").inTable("notification").onDelete("CASCADE");
        table.integer("email_revision").notNullable();
    });
    await knex.schema.createTable("notification_alert", (table) => {
        table
            .integer("delivery_id")
            .unsigned()
            .primary()
            .references("id")
            .inTable("notification_delivery")
            .onDelete("CASCADE");
        table.string("rule_revision", 36).notNullable();
        table.string("token", 22).notNullable().unique();
        table.bigInteger("due_at").notNullable();
        table.bigInteger("closed_at").nullable();
        table
            .integer("fallback_id")
            .unsigned()
            .nullable()
            .references("id")
            .inTable("notification_delivery")
            .onDelete("SET NULL");
        table.index(["closed_at", "due_at"]);
    });
};

exports.down = async (knex) => {
    await knex.schema.dropTable("notification_alert");
    await knex.schema.dropTable("monitor_alert_rule");
};
