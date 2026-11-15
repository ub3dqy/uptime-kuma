// Run against a stopped owned clone or from a network-isolated restore container.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { ProjectVault } = require("../server/projects/vault");
/**
 * @param {string} folder Complete stopped data copy
 * @returns {object} Counts and decryption evidence without any secret contents
 */
function verify(folder) {
    const db = new Database(path.join(folder, "kuma.db"), { readonly: true, fileMustExist: true });
    try {
        if (
            db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
            db.prepare("PRAGMA foreign_key_check").all().length
        )
            throw new Error("Invalid restored database");
        const tables = new Set(
            db
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .all()
                .map((row) => row.name)
        );
        const required = [
            "project",
            "project_ai",
            "project_ai_job",
            "project_recovery",
            "project_ai_automation",
            "project_dependency",
            "witness_state",
        ];
        if (required.some((table) => !tables.has(table))) throw new Error("Missing product tables");
        const keyFile = path.join(folder, "project-secrets/keys.json");
        const vault = fs.existsSync(keyFile) ? new ProjectVault(keyFile, true) : null;
        let grants = 0;
        let points = 0;
        let channels = 0;
        for (const row of db
            .prepare("SELECT project_id,secret_cipher FROM project_ai WHERE secret_cipher IS NOT NULL")
            .all()) {
            if (!vault) throw new Error("Missing retained keys");
            vault.open(row.project_id, row.secret_cipher);
            grants++;
        }
        for (const row of db
            .prepare("SELECT project_id,snapshot_cipher FROM project_recovery WHERE snapshot_cipher IS NOT NULL")
            .all()) {
            if (!vault) throw new Error("Missing recovery keys");
            vault.open(row.project_id, row.snapshot_cipher, "recovery");
            points++;
        }
        for (const row of db.prepare("SELECT user_id,config FROM notification").all()) {
            const config = JSON.parse(row.config);
            if (config.projectEncryption) {
                if (!vault) throw new Error("Missing channel keys");
                const value = vault.open(
                    config.projectEncryption.projectID,
                    config.projectEncryption.cipher,
                    "notification"
                );
                if (value.__dataOwnerID !== row.user_id) throw new Error("Channel owner differs");
                channels++;
            }
        }
        return {
            integrity: "ok",
            foreignKeyViolations: 0,
            retainedMonitors: db.prepare("SELECT COUNT(*) n FROM monitor").get().n,
            retainedObservations: db.prepare("SELECT COUNT(*) n FROM heartbeat").get().n,
            decryptedAIGrants: grants,
            decryptedRecoveryPoints: points,
            decryptedChannels: channels,
            expiresAt: null,
        };
    } finally {
        db.close();
    }
}
if (require.main === module) {
    try {
        console.log(JSON.stringify(verify(path.resolve(process.argv[2] || "data"))));
    } catch {
        console.error("Complete product data verification failed; no secrets were printed.");
        process.exitCode = 1;
    }
}
module.exports = { verify };
