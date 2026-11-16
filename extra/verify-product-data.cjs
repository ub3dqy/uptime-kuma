// Run against a stopped owned clone or from a network-isolated restore container.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
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
            "project_site_recovery",
            "project_site_recovery_target",
            "project_site_recovery_worker",
            "project_code_recovery",
            "project_code_recovery_target",
            "project_code_recovery_worker",
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
        let codeSources = 0;
        for (const row of db
            .prepare("SELECT project_id,source_cipher,plan_hash,plan_json,backup_json FROM project_code_recovery")
            .all()) {
            if (!vault) throw new Error("Missing code source keys");
            const source = vault.open(row.project_id, row.source_cipher, "code");
            if (!source.codeRepair?.source?.sourceHash) throw new Error("Invalid retained code source");
            if (
                row.plan_hash &&
                createHash("sha256").update(row.plan_json).digest("hex") !== row.plan_hash
            )
                throw new Error("Invalid retained code plan");
            if (row.backup_json && JSON.parse(row.backup_json).expiresAt !== null)
                throw new Error("Code backup must be retained");
            codeSources++;
        }
        for (const row of db
            .prepare(
                "SELECT project_id,code_input_cipher,code_result_cipher FROM project_ai_job WHERE code_input_cipher IS NOT NULL OR code_result_cipher IS NOT NULL"
            )
            .all()) {
            if (!vault) throw new Error("Missing code job keys");
            for (const field of ["code_input_cipher", "code_result_cipher"])
                if (row[field]) vault.open(row.project_id, row[field], "code");
        }
        const sitePoints = db.prepare(`
            SELECT r.backup_json, r.plan_json, r.plan_hash, r.project_id, r.ai_job_id, p.owner_id
            FROM project_site_recovery r JOIN project p ON p.id = r.project_id
        `).all();
        for (const row of sitePoints) {
            const plan = JSON.parse(row.plan_json);
            const body = JSON.stringify({ projectID: row.project_id, aiJobID: row.ai_job_id, ownerID: row.owner_id, ...plan });
            if (createHash("sha256").update(body).digest("hex") !== row.plan_hash || !["restart_service", "restore_index"].includes(plan.action))
                throw new Error("Invalid retained site recovery plan");
            if (row.backup_json) {
                const point = JSON.parse(row.backup_json);
                if (point.expiresAt !== null || !/^[a-f0-9]{64}$/.test(point.digest))
                    throw new Error("Invalid retained site recovery receipt");
            }
        }
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
            decryptedCodeSources: codeSources,
            retainedSiteRecoveryPlans: sitePoints.length,
            retainedSiteRecoveryReceipts: sitePoints.filter((row) => row.backup_json).length,
            siteRecoveryHostBackupsCheckedHere: false,
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
