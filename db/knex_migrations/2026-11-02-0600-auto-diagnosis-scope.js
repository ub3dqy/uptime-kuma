exports.up = async (knex) => {
    await knex.schema.alterTable("project_ai_automation", (table) => {
        table.text("monitor_ids_json").nullable();
    });
    const previous = await knex("project_ai_automation as a")
        .join("project as p", "p.id", "a.project_id")
        .select("a.project_id", "p.data_user_id");
    for (const policy of previous) {
        const monitors = await knex("monitor")
            .where({ user_id: policy.data_user_id })
            .whereNot("type", "group")
            .orderBy("id")
            .select("id")
            .limit(201);
        // An oversized old project was already inactive. Never silently select only part of it.
        const ids = monitors.length > 200 ? [] : monitors.map((monitor) => monitor.id);
        await knex("project_ai_automation")
            .where({ project_id: policy.project_id })
            .update({ monitor_ids_json: JSON.stringify(ids) });
    }
};

exports.down = async () => {
    throw new Error("Restore the complete pre-update backup; do not broaden saved automatic diagnosis consent.");
};
