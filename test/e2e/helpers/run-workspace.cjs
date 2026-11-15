// Reproducible workspace verification. All network peers and secrets stay local.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { execFileSync, fork, spawn } = require("node:child_process");

/** @returns {Promise<void>} Run against new owned data without deleting any prior result */
async function main() {
    const root = path.resolve(__dirname, "../../..");
    const relativeData = process.env.KUMA_E2E_DATA_DIR || `private/e2e-workspace-${randomBytes(6).toString("hex")}`;
    if (!/^private\/e2e-workspace-[a-f0-9]{12}$/.test(relativeData)) {
        throw new Error("Use a new private/e2e-workspace- followed by 12 hex characters");
    }
    const data = path.resolve(root, relativeData);
    if (fs.existsSync(data)) {
        throw new Error("Test data already exists; use a new directory. Existing data was preserved.");
    }
    fs.mkdirSync(path.dirname(data), { recursive: true, mode: 0o700 });
    fs.mkdirSync(data, { mode: 0o700 });
    if (process.platform === "win32") {
        const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
        execFileSync(
            "icacls.exe",
            [data, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"],
            { stdio: "ignore", timeout: 10000, windowsHide: true }
        );
    }
    const folder = path.join(data, "peer");
    fs.mkdirSync(folder, { mode: 0o700 });
    const certificate = path.join(folder, "fixture-cert.pem");
    const key = path.join(folder, "fixture-key.pem");
    const gitOpenSSL = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
    const openssl =
        process.env.OPENSSL_BIN || (process.platform === "win32" && fs.existsSync(gitOpenSSL) ? gitOpenSSL : "openssl");
    execFileSync(
        openssl,
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "2",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-keyout",
            key,
            "-out",
            certificate,
        ],
        { stdio: "ignore", timeout: 30000, windowsHide: true }
    );
    if (process.platform !== "win32") {
        fs.chmodSync(key, 0o600);
    }
    const env = {
        ...process.env,
        KUMA_E2E_DATA_DIR: relativeData,
        KUMA_STAGE2_FIXTURE_DIR: folder,
        NODE_EXTRA_CA_CERTS: certificate,
        UPTIME_KUMA_RECOVERY_MANIFEST: path.join(folder, "recovery-manifest.json"),
    };
    const peer = fork(path.join(__dirname, "stage2-peer.cjs"), [], {
        cwd: root,
        env,
        stdio: "inherit",
        windowsHide: true,
    });
    const aiPeer = fork(path.join(__dirname, "stage3-ai-peer.cjs"), [], {
        cwd: root,
        env,
        stdio: "inherit",
        windowsHide: true,
    });
    let runner;
    const recoveryPeer = fork(path.join(__dirname, "stage4-recovery-peer.cjs"), [], {
        cwd: root,
        env,
        stdio: "inherit",
        windowsHide: true,
    });
    const stop = () => {
        if (runner && runner.exitCode === null && !runner.killed) {
            runner.kill();
        }
        if (peer.exitCode === null && !peer.killed) {
            peer.kill();
        }
        if (aiPeer.exitCode === null && !aiPeer.killed) {
            aiPeer.kill();
        }
        if (recoveryPeer.exitCode === null && !recoveryPeer.killed) {
            recoveryPeer.kill();
        }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        await new Promise((resolve, reject) => {
            const started = Date.now();
            const poll = setInterval(() => {
                if (
                    fs.existsSync(path.join(folder, "fixture.json")) &&
                    fs.existsSync(path.join(folder, "ai-fixture.json")) &&
                    fs.existsSync(path.join(folder, "recovery-fixture.json"))
                ) {
                    clearInterval(poll);
                    resolve();
                } else if (peer.exitCode !== null || Date.now() - started >= 10000) {
                    clearInterval(poll);
                    reject(new Error("Owned test peers could not start"));
                }
            }, 50);
        });
        console.log(`Local test data and report: ${relativeData}`);
        runner = spawn(
            process.execPath,
            [
                require.resolve("@playwright/test/cli"),
                "test",
                "--config",
                "config/playwright.workspace.config.js",
                ...process.argv.slice(2),
            ],
            { cwd: root, env, stdio: "inherit", windowsHide: true }
        );
        process.exitCode = await new Promise((resolve, reject) => {
            runner.once("error", reject);
            runner.once("exit", (code) => resolve(code ?? 1));
        });
    } finally {
        stop();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
    }
}

main().catch(() => {
    // Never print command output that could contain test credentials or certificate keys.
    console.error(
        "Local workspace verification could not finish. Check Node, OpenSSL, free ports and the saved report. Existing data was preserved."
    );
    process.exitCode = 1;
});
