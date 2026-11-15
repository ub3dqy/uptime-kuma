exports.up = async (knex) => {
    await knex.schema.createTable("project_dependency", (t) => {
        t.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("RESTRICT");
        t.integer("monitor_id").unsigned().notNullable().references("id").inTable("monitor").onDelete("CASCADE");
        t.integer("depends_on").unsigned().notNullable().references("id").inTable("monitor").onDelete("CASCADE");
        t.primary(["project_id", "monitor_id", "depends_on"]);
    });
};
exports.down = async () => {
    throw new Error("Restore the complete pre-update backup to preserve approved dependencies.");
};
