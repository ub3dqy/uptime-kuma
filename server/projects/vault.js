const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { problem, id } = require("./access");
let cached;
let existingEncryptedSecrets = false;

/**
 * @param {string[]} filenames Dedicated protected files and directories
 * @returns {void} Refuse a shared location before writing credentials
 * @throws {Error} Unprotected location
 */
function protectedLocation(filenames) {
    for (const filename of filenames) {
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink() || (process.platform !== "win32" && stat.mode & 0o077)) {
            throw problem("projectKeyMissing");
        }
    }
    if (process.platform === "win32") {
        const script =
            "$ErrorActionPreference='Stop'; $allowed=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); foreach($path in ($env:UPTIME_KUMA_KEY_ACL_PATHS | ConvertFrom-Json)) { foreach($rule in (Get-Acl -LiteralPath $path).Access) { if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) { exit 1 } } }";
        try {
            const environment = { ...process.env, UPTIME_KUMA_KEY_ACL_PATHS: JSON.stringify(filenames) };
            // A PowerShell 7 parent can pass incompatible module paths to Windows PowerShell.
            delete environment.PSModulePath;
            execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
                env: environment,
                stdio: "ignore",
                timeout: 20000,
                windowsHide: true,
            });
        } catch {
            throw problem("projectKeyMissing");
        }
    }
}

/** Encrypted project credentials. The key ring is a protected file, never a database row. */
class ProjectVault {
    /**
     * @param {string} filename Protected key file
     * @param {boolean} existingSecrets Fail closed if keys were lost
     * @throws {Error} Invalid value or unavailable protected data
     */
    constructor(filename, existingSecrets = false) {
        this.filename = path.resolve(filename);
        const folder = path.dirname(this.filename);
        const created = !fs.existsSync(this.filename);
        if (created) {
            if (existingSecrets) {
                throw problem("projectKeyMissing");
            }
            const fresh = !fs.existsSync(folder);
            fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
            if (fs.lstatSync(folder).isSymbolicLink()) {
                throw problem("projectKeyMissing");
            }
            if (fresh && process.platform === "win32") {
                execFileSync(
                    "icacls.exe",
                    [
                        folder,
                        "/inheritance:r",
                        "/grant:r",
                        `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,
                        "*S-1-5-18:(OI)(CI)F",
                    ],
                    { stdio: "ignore", timeout: 10000, windowsHide: true }
                );
            }
            protectedLocation([folder]);
            const keyID = crypto.randomBytes(8).toString("hex");
            this.ring = { version: 1, active: keyID, keys: { [keyID]: crypto.randomBytes(32).toString("base64") } };
            this.write(true);
        }
        const stat = fs.lstatSync(this.filename);
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > 65536 ||
            (process.platform !== "win32" && stat.mode & 0o077)
        ) {
            throw problem("projectKeyMissing");
        }
        // A freshly created file inherits only the just-validated dedicated
        // directory's principals. Existing copies require both ACLs to be checked.
        if (!created) {
            protectedLocation([folder, this.filename]);
        }
        try {
            this.ring = JSON.parse(fs.readFileSync(this.filename, "utf8"));
            if (
                this.ring.version !== 1 ||
                !this.ring.keys[this.ring.active] ||
                Object.values(this.ring.keys).some(
                    (key) => typeof key !== "string" || Buffer.from(key, "base64").length !== 32
                )
            ) {
                throw new Error();
            }
        } catch {
            throw problem("projectKeyMissing");
        }
    }
    /**
     * @param {boolean} exclusive Never overwrite an existing first key
     * @throws {Error} If the keyring is too large or the protected write fails
     * @returns {void} Durable write
     */
    write(exclusive = false) {
        const body = JSON.stringify(this.ring);
        if (Buffer.byteLength(body) > 65536) {
            throw problem("projectKeyMissing");
        }
        const temporary = this.filename + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
        const fd = fs.openSync(exclusive ? this.filename : temporary, "wx", 0o600);
        try {
            fs.writeFileSync(fd, body);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (!exclusive) {
            fs.renameSync(temporary, this.filename);
        }
    }
    /**
     * @param {number} projectID Scope
     * @param {object} value Secret
     * @param {string} purpose Fixed purpose
     * @returns {string} Authenticated ciphertext
     * @throws {Error} Invalid value or unavailable protected data
     */
    seal(projectID, value, purpose = "ai") {
        const bytes = Buffer.from(JSON.stringify(value));
        if (
            bytes.length > (purpose === "code" ? 196608 : 65536) ||
            !["ai", "notification", "recovery", "code"].includes(purpose)
        ) {
            throw problem("projectInvalid");
        }
        const kid = this.ring.active;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(this.ring.keys[kid], "base64"), iv);
        cipher.setAAD(Buffer.from(`uptime-kuma:project:${id(projectID)}:${purpose}:v1`));
        const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return JSON.stringify({
            v: 1,
            kid,
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            data: data.toString("base64"),
        });
    }
    /**
     * @param {number} projectID Scope
     * @param {string} value Ciphertext
     * @param {string} purpose Fixed purpose
     * @returns {object} Secret in server memory only
     * @throws {Error} Invalid value or unavailable protected data
     */
    open(projectID, value, purpose = "ai") {
        try {
            if (typeof value !== "string" || value.length > (purpose === "code" ? 300000 : 100000)) {
                throw new Error();
            }
            const envelope = JSON.parse(value);
            if (envelope.v !== 1 || !Object.hasOwn(this.ring.keys, envelope.kid)) {
                throw new Error();
            }
            const decipher = crypto.createDecipheriv(
                "aes-256-gcm",
                Buffer.from(this.ring.keys[envelope.kid], "base64"),
                Buffer.from(envelope.iv, "base64")
            );
            decipher.setAAD(Buffer.from(`uptime-kuma:project:${id(projectID)}:${purpose}:v1`));
            decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
            return JSON.parse(
                Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString(
                    "utf8"
                )
            );
        } catch {
            throw problem("projectKeyMissing");
        }
    }
    /**
     * Retain previous key versions so protected recovery copies remain readable.
     * @param {object} db Database
     * @returns {Promise<void>} All current encrypted rows rewrapped
     */
    async rotate(db) {
        const kid = crypto.randomBytes(8).toString("hex");
        this.ring.keys[kid] = crypto.randomBytes(32).toString("base64");
        this.write(); // Both keys must be durable before any row uses the new one.
        const previous = this.ring.active;
        this.ring.active = kid;
        try {
            await db.transaction(async (tx) => {
                const configs = await tx("project_ai").whereNotNull("secret_cipher");
                for (const config of configs) {
                    await tx("project_ai")
                        .where({ project_id: config.project_id })
                        .update({
                            secret_cipher: this.seal(
                                config.project_id,
                                this.open(config.project_id, config.secret_cipher)
                            ),
                            revision: config.revision + 1,
                            state: config.mode === "off" ? "off" : "saved",
                            verified_at: null,
                        });
                }
                const channels = await tx("notification").select("id", "config");
                for (const channel of channels) {
                    let config;
                    try {
                        config = JSON.parse(channel.config);
                    } catch {
                        continue;
                    }
                    if (config.projectEncryption) {
                        const p = config.projectEncryption;
                        p.cipher = this.seal(
                            p.projectID,
                            this.open(p.projectID, p.cipher, "notification"),
                            "notification"
                        );
                        await tx("notification")
                            .where({ id: channel.id })
                            .update({ config: JSON.stringify(config) });
                    }
                }
                if (await tx.schema.hasTable("project_recovery")) {
                    let afterID = 0;
                    for (;;) {
                        const points = await tx("project_recovery")
                            .whereNotNull("snapshot_cipher")
                            .where("id", ">", afterID)
                            .orderBy("id")
                            .limit(50);
                        if (!points.length) {
                            break;
                        }
                        for (const point of points) {
                            await tx("project_recovery")
                                .where({ id: point.id })
                                .update({
                                    snapshot_cipher: this.seal(
                                        point.project_id,
                                        this.open(point.project_id, point.snapshot_cipher, "recovery"),
                                        "recovery"
                                    ),
                                });
                        }
                        afterID = points.at(-1).id;
                    }
                }
                for (const [table, columns] of [
                    ["project_ai_job", ["code_input_cipher", "code_result_cipher"]],
                    ["project_code_recovery", ["source_cipher"]],
                ]) {
                    if (!(await tx.schema.hasTable(table))) continue;
                    if (!(await tx.schema.hasColumn(table, columns[0]))) continue;
                    let afterID = 0;
                    for (;;) {
                        const rows = await tx(table).where("id", ">", afterID).orderBy("id").limit(50);
                        if (!rows.length) break;
                        for (const row of rows) {
                            const update = {};
                            for (const column of columns)
                                if (row[column])
                                    update[column] = this.seal(
                                        row.project_id,
                                        this.open(row.project_id, row[column], "code"),
                                        "code"
                                    );
                            if (Object.keys(update).length) await tx(table).where({ id: row.id }).update(update);
                        }
                        afterID = rows.at(-1).id;
                    }
                }
            });
            this.write();
        } catch (error) {
            this.ring.active = previous;
            throw error;
        }
    }
}

/**
 * @returns {ProjectVault} The current instance's separate protected key ring
 * @throws {Error} Missing or unreadable protected key file
 */
function getVault() {
    const Database = require("../database");
    const filename =
        process.env.UPTIME_KUMA_PROJECT_KEY_FILE || path.resolve(Database.dataDir, "project-secrets", "keys.json");
    if (!cached || cached.filename !== path.resolve(filename)) {
        // Existing encrypted rows are checked asynchronously before first use at startup.
        if (!fs.existsSync(filename) && cached?.filename === path.resolve(filename)) {
            throw problem("projectKeyMissing");
        }
        cached = new ProjectVault(filename, existingEncryptedSecrets);
    } else if (!fs.existsSync(filename)) {
        throw problem("projectKeyMissing");
    }
    return cached;
}

/**
 * @param {object} db Ready database
 * @returns {Promise<void>} Prevent replacing a lost encryption key
 */
async function initializeVaultState(db) {
    const secret = await db("project_ai").whereNotNull("secret_cipher").first();
    const channel = await db("notification").where("config", "like", '%"projectEncryption"%').first();
    const recovery =
        (await db.schema.hasTable("project_recovery")) &&
        (await db("project_recovery").whereNotNull("snapshot_cipher").first());
    existingEncryptedSecrets = Boolean(secret || channel || recovery);
}

module.exports = { ProjectVault, getVault, initializeVaultState, protectedLocation };
