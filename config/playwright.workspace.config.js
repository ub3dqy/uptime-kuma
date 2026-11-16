import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Every run uses a new owned directory. Never remove or reuse an existing database.
const dataDir = process.env.KUMA_E2E_DATA_DIR;
if (!/^private\/e2e-workspace-[a-f0-9]{12}$/.test(dataDir || "")) {
    throw new Error("Set KUMA_E2E_DATA_DIR to private/e2e-workspace- followed by 12 random hex characters");
}
const url = "http://127.0.0.1:30001";
process.env.KUMA_E2E_DB_PATH = path.resolve(dataDir, "kuma.db");
process.env.KUMA_E2E_SERVER_URL = url;

export default defineConfig({
    testDir: "../test/e2e/specs",
    testMatch:
        /(?:workspace|client-groups|heartbeat-export|stage2-workflow|stage3-projects|stage4-recovery|site-work|site-recovery|code-recovery)\.spec\.js/,
    outputDir: `../${dataDir}/results`,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: [["list"], ["html", { outputFolder: path.resolve(dataDir, "report"), open: "never" }]],
    use: {
        ...devices["Desktop Chrome"],
        baseURL: url,
        locale: "en-US",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: `node --require ./test/e2e/helpers/install-project-ai-fixture.cjs server/server.js --host=127.0.0.1 --port=30001 --data-dir=./${dataDir}`,
        url,
        reuseExistingServer: false,
        cwd: "../",
        env: {
            NODE_ENV: "development",
            UPTIME_KUMA_DB_TYPE: "sqlite",
            UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB: "0",
            UPTIME_KUMA_LOCAL_OAUTH: "1",
        },
    },
});
