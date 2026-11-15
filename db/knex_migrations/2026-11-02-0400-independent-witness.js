exports.up = async (knex) => {
    await knex.schema.createTable("witness_state", (t) => {
        t.string("node_id", 48).primary();
        t.string("config_hash", 64).notNullable();
        t.bigInteger("last_seen").notNullable();
        t.string("channels", 64).notNullable();
    });
    await knex.schema.createTable("witness_nonce", (t) => {
        t.string("nonce", 64).primary();
        t.bigInteger("expires_at").notNullable().index();
    });
};
exports.down = async () => {
    throw new Error("Restore the complete pre-update backup to preserve independent observation history.");
};
