// Read only the just-created synthetic test database; never accept a production path.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const SQLite = require("better-sqlite3");
const { ProjectVault } = require("../../../server/projects/vault");

/** @returns {Promise<void>} Retain an independently readable database and protected key copy */
async function main() {
    const source = process.argv[2];
    if (!/^private\/e2e-workspace-[a-f0-9]{12}$/.test(source || "")) {
        throw new Error("Foreign restore source refused");
    }
    const folder = path.resolve(source, "restored-" + crypto.randomBytes(6).toString("hex"));
    fs.mkdirSync(folder, { mode: 0o700 });
    fs.mkdirSync(path.join(folder, "project-secrets"), { mode: 0o700 });
    const original = new SQLite(path.resolve(source, "kuma.db"), { readonly: true, fileMustExist: true });
    await original.backup(path.join(folder, "kuma.db"));
    fs.copyFileSync(path.resolve(source, "project-secrets/keys.json"), path.join(folder, "project-secrets/keys.json"));
    const restored = new SQLite(path.join(folder, "kuma.db"), { readonly: true, fileMustExist: true });
    try {
        const tables = [
            "project",
            "project_member",
            "project_identity",
            "monitor",
            "heartbeat",
            "notification",
            "notification_delivery",
            "project_delivery_actor",
            "project_ai_job",
            "project_audit",
            "project_recovery",
            "project_recovery_target",
        ];
        const counts = {};
        for (const table of tables) {
            const before = original.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
            const after = restored.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
            assert.equal(after, before, table);
            counts[table] = after;
        }
        assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM user WHERE project_only=1 AND active<>0").get().n, 0);
        assert.equal(restored.prepare("PRAGMA foreign_key_check").all().length, 0);
        assert.equal(
            restored.prepare("SELECT value FROM setting WHERE key='jwtSecret'").get().value,
            original.prepare("SELECT value FROM setting WHERE key='jwtSecret'").get().value
        );
        const vault = new ProjectVault(path.join(folder, "project-secrets/keys.json"), true);
        let encryptedAI = 0;
        for (const config of restored
            .prepare("SELECT project_id,secret_cipher FROM project_ai WHERE secret_cipher IS NOT NULL")
            .all()) {
            const secret = vault.open(config.project_id, config.secret_cipher);
            assert.ok(["subscription", "api"].includes(secret.kind));
            encryptedAI++;
        }
        let encryptedChannels = 0;
        for (const row of restored.prepare("SELECT user_id,config FROM notification").all()) {
            const envelope = JSON.parse(row.config).projectEncryption;
            if (!envelope) {
                continue;
            }
            const config = vault.open(envelope.projectID, envelope.cipher, "notification");
            assert.equal(config.__dataOwnerID, row.user_id);
            encryptedChannels++;
        }
        assert.ok(encryptedAI > 0 && encryptedChannels > 0);
        let encryptedRecovery = 0;
        for (const point of restored
            .prepare(
                "SELECT id,project_id,monitor_id,plan_hash,plan_json,snapshot_cipher FROM project_recovery WHERE snapshot_cipher IS NOT NULL"
            )
            .all()) {
            const snapshot = vault.open(point.project_id, point.snapshot_cipher, "recovery");
            const plan = JSON.parse(point.plan_json);
            const bytes = Buffer.from(snapshot.bytes, "base64");
            assert.equal(snapshot.planHash, point.plan_hash);
            assert.equal(snapshot.target.projectID, point.project_id);
            assert.equal(snapshot.target.monitorID, point.monitor_id);
            assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), plan.beforeHash);
            const recoveredFile = path.join(folder, "recovered-configuration-" + point.id + ".json");
            fs.writeFileSync(recoveredFile, bytes, { mode: 0o600, flag: "wx" });
            assert.deepEqual(fs.readFileSync(recoveredFile), bytes);
            encryptedRecovery++;
        }
        console.log(
            JSON.stringify(
                {
                    source,
                    restored: path.relative(process.cwd(), folder).replaceAll("\\", "/"),
                    counts,
                    encryptedAI,
                    encryptedChannels,
                    encryptedRecovery,
                    preservedJWT: true,
                    legacyParticipantLoginsDisabled: true,
                    foreignKeyViolations: 0,
                    networkRequests: 0,
                },
                null,
                2
            )
        );
    } finally {
        original.close();
        restored.close();
    }
}
main().catch(() => {
    console.error("Synthetic restore verification failed; all files were retained.");
    process.exitCode = 1;
});
