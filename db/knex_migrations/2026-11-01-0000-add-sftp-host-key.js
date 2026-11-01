exports.up = (knex) =>
    knex.schema.alterTable("monitor", (table) => {
        table.string("ssh_host_key_fingerprint", 80);
    });

exports.down = (knex) =>
    knex.schema.alterTable("monitor", (table) => {
        table.dropColumn("ssh_host_key_fingerprint");
    });
