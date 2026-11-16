const { randomUUID } = require("node:crypto");

exports.up = async (knex) => {
    await knex.schema.alterTable("user", (table) => {
        table.integer("project_only").notNullable().defaultTo(0);
        table.integer("service_account").notNullable().defaultTo(0);
    });
    // Participant credentials live outside the legacy login table. An older
    // binary must not turn an invited viewer into an installation administrator.
    await knex.schema.createTable("project_identity", (table) => {
        table.integer("user_id").unsigned().primary().references("id").inTable("user").onDelete("CASCADE");
        table.text("password").notNullable();
        table.integer("active").notNullable().defaultTo(1);
    });
    await knex.schema.createTable("project", (table) => {
        table.increments("id");
        table.integer("owner_id").unsigned().notNullable().references("id").inTable("user").onDelete("RESTRICT");
        table
            .integer("data_user_id")
            .unsigned()
            .notNullable()
            .unique()
            .references("id")
            .inTable("user")
            .onDelete("RESTRICT");
        table.string("name", 120).notNullable();
        table.string("timezone", 64).notNullable().defaultTo("UTC");
        table.text("allowed_ips_json").notNullable();
        table.integer("personal").notNullable().defaultTo(0);
        table.integer("revision").notNullable().defaultTo(1);
        table.bigInteger("created_at").notNullable();
    });
    await knex.schema.createTable("project_member", (table) => {
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("user").onDelete("CASCADE");
        table.string("role", 16).notNullable();
        table.primary(["project_id", "user_id"]);
        table.index(["user_id", "project_id"]);
    });
    await knex.schema.createTable("project_invite", (table) => {
        table.increments("id");
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.integer("created_by").unsigned().notNullable().references("id").inTable("user").onDelete("CASCADE");
        table.string("token_hash", 64).notNullable().unique();
        table.string("role", 16).notNullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("expires_at").notNullable();
        table.bigInteger("used_at").nullable();
    });
    await knex.schema.createTable("project_audit", (table) => {
        table.increments("id");
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.integer("user_id").unsigned().nullable().references("id").inTable("user").onDelete("SET NULL");
        table.string("action", 40).notNullable();
        table.string("target", 80).nullable();
        table.bigInteger("created_at").notNullable();
        table.index(["project_id", "id"]);
    });
    await knex.schema.createTable("project_ai", (table) => {
        table.integer("project_id").unsigned().primary().references("id").inTable("project").onDelete("CASCADE");
        table.integer("revision").notNullable().defaultTo(1);
        table.string("mode", 16).notNullable().defaultTo("off");
        table.string("model", 150).nullable();
        table.string("host_id", 64).notNullable();
        table.integer("daily_limit").notNullable().defaultTo(5);
        table.integer("timeout_seconds").notNullable().defaultTo(45);
        table.integer("max_output_tokens").notNullable().defaultTo(1024);
        table.integer("allow_names").notNullable().defaultTo(0);
        table.integer("allow_hosts").notNullable().defaultTo(0);
        table.integer("allow_history").notNullable().defaultTo(1);
        table.text("secret_cipher").nullable();
        table.text("registration_json").nullable();
        table.text("models_json").nullable();
        table.string("state", 24).notNullable().defaultTo("off");
        table.bigInteger("verified_at").nullable();
        table.string("error_code", 40).nullable();
    });
    await knex.schema.createTable("project_ai_job", (table) => {
        table.increments("id");
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.integer("user_id").unsigned().nullable().references("id").inTable("user").onDelete("SET NULL");
        table.integer("monitor_id").unsigned().nullable().references("id").inTable("monitor").onDelete("SET NULL");
        table.integer("revision").notNullable();
        table.integer("project_revision").notNullable();
        table.string("kind", 16).notNullable();
        table.string("status", 24).notNullable();
        table.string("bucket_day", 10).notNullable();
        table.text("input_json").notNullable();
        table.text("result_json").nullable();
        table.text("usage_json").nullable();
        table.string("error_code", 40).nullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("updated_at").notNullable();
        table.index(["project_id", "bucket_day"]);
        table.index(["status", "id"]);
    });
    await knex.schema.createTable("project_oauth_pairing", (table) => {
        table.string("id", 64).primary();
        table.integer("project_id").unsigned().notNullable().references("id").inTable("project").onDelete("CASCADE");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("user").onDelete("CASCADE");
        table.string("token_hash", 64).notNullable();
        table.string("nonce", 64).notNullable();
        table.integer("project_revision").notNullable();
        table.integer("config_revision").notNullable();
        table.bigInteger("expires_at").notNullable();
        table.bigInteger("used_at").nullable();
        table.string("client_id", 200).nullable();
        table.string("expected_subject", 255).nullable();
    });
    const users = await knex("user").select("id", "username");
    for (const user of users) {
        const [projectID] = await knex("project").insert({
            owner_id: user.id,
            data_user_id: user.id,
            name: String(user.username || "My project").slice(0, 120),
            personal: 1,
            timezone: "UTC",
            allowed_ips_json: "[]",
            created_at: Date.now(),
        });
        await knex("project_member").insert({ project_id: projectID, user_id: user.id, role: "admin" });
        await knex("project_ai").insert({ project_id: projectID, host_id: "urn:uuid:" + randomUUID() });
    }
};

exports.down = async (knex) => {
    if (Number((await knex("user").where({ project_only: 1 }).count({ n: "id" }).first()).n)) {
        throw new Error(
            "Restore the pre-project backup to roll back after creating projects or participants; their data must not be discarded."
        );
    }
    // A project data owner must never become a reusable login after rollback.
    for (const table of [
        "project_oauth_pairing",
        "project_ai_job",
        "project_ai",
        "project_audit",
        "project_invite",
        "project_member",
        "project",
    ]) {
        await knex.schema.dropTable(table);
    }
    await knex.schema.dropTable("project_identity");
    await knex.schema.alterTable("user", (table) => {
        table.dropColumn("project_only");
        table.dropColumn("service_account");
    });
};
