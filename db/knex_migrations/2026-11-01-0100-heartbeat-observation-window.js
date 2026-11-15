exports.up = (knex) =>
    knex.schema.alterTable("heartbeat", (table) => {
        // Old rows deliberately remain NULL: today's schedule cannot describe old gaps.
        table.double("check_interval").nullable();
        table.string("check_session", 36).nullable();
    });

exports.down = (knex) =>
    knex.schema.alterTable("heartbeat", (table) => {
        table.dropColumn("check_interval");
        table.dropColumn("check_session");
    });
