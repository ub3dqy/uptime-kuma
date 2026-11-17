const fs = require("fs");
const path = require("path");
const serverUrl = process.env.KUMA_E2E_SERVER_URL || require("../../config/playwright.config.js").url;

export const e2eOwnerPassword = "Kuma-dev-owner-sample-382";

const dbPath = process.env.KUMA_E2E_DB_PATH
    ? path.resolve(process.env.KUMA_E2E_DB_PATH)
    : "./../../data/playwright-test/kuma.db";

/** @returns {string} Code from the isolated application's private data folder. */
export function getSetupCode() {
    return fs.readFileSync(path.join(path.dirname(path.resolve(__dirname, dbPath)), ".setup-code"), "utf8").trim();
}

/**
 * @param {TestInfo} testInfo Test info
 * @param {Page} page Page
 * @returns {Promise<void>}
 */
export async function screenshot(testInfo, page) {
    const screenshot = await page.screenshot();
    await testInfo.attach("screenshot", {
        body: screenshot,
        contentType: "image/png",
    });
}

/**
 * @param {Page} page Page
 * @returns {Promise<void>}
 */
export async function login(page) {
    // Login
    await page.getByPlaceholder("Username").click();
    await page.getByPlaceholder("Username").fill("admin");
    await page.getByPlaceholder("Username").press("Tab");
    await page.getByPlaceholder("Password").fill(e2eOwnerPassword);
    await page.getByLabel("Remember me").check();
    await page.getByRole("button", { name: "Log in" }).click();
    await page.isVisible("text=Add New Monitor");
}

/**
 * Determines if the SQLite database has been created. This indicates setup has completed.
 * @returns {boolean} True if exists
 */
export function getSqliteDatabaseExists() {
    return fs.existsSync(path.resolve(__dirname, dbPath));
}

/**
 * Makes a request to the server to take a snapshot of the SQLite database.
 * @param {Page|null} page Page
 * @returns {Promise<Response>} Promise of response from snapshot request.
 */
export async function takeSqliteSnapshot(page = null) {
    if (page) {
        return page.goto("./_e2e/take-sqlite-snapshot");
    } else {
        return fetch(`${serverUrl}/_e2e/take-sqlite-snapshot`);
    }
}

/**
 * Makes a request to the server to restore the snapshot of the SQLite database.
 * @returns {Promise<Response>} Promise of response from restoration request.
 */
export async function restoreSqliteSnapshot() {
    return fetch(`${serverUrl}/_e2e/restore-sqlite-snapshot`);
}
