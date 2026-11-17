import { test } from "@playwright/test";
import { e2eOwnerPassword, getSetupCode, getSqliteDatabaseExists, login, screenshot, takeSqliteSnapshot } from "../util-test";

test.describe("Uptime Kuma Setup", () => {
    test.skip(() => getSqliteDatabaseExists(), "Must only run once per session");

    test.afterEach(async ({ page }, testInfo) => {
        await screenshot(testInfo, page);
    });

    /*
     * Setup
     */

    test("setup sqlite", async ({ page }, testInfo) => {
        await page.goto("./");
        await page.getByText("SQLite").click();
        await page.getByLabel("Installation code").fill(getSetupCode());
        await page.getByRole("button", { name: "Next" }).click();
        await screenshot(testInfo, page);
        await page.waitForURL("/setup"); // ensures the server is ready to continue to the next test
    });

    test("setup admin", async ({ page }) => {
        await page.goto("./");
        await page.getByLabel("Installation code").fill(getSetupCode());
        await page.getByPlaceholder("Username").click();
        await page.getByPlaceholder("Username").fill("admin");
        await page.getByPlaceholder("Username").press("Tab");
        await page.getByPlaceholder("Password", { exact: true }).fill(e2eOwnerPassword);
        await page.getByPlaceholder("Password", { exact: true }).press("Tab");
        await page.getByPlaceholder("Repeat Password").fill(e2eOwnerPassword);
        await page.getByRole("button", { name: "Create account", exact: true }).click();
        await page.waitForURL("/start");
    });

    /*
     * All other tests should be run after setup
     */

    test("login", async ({ page }) => {
        await page.goto("./dashboard");
        await login(page);
    });

    test("logout", async ({ page }) => {
        await page.goto("./dashboard");
        await login(page);
        await page.getByText("A", { exact: true }).click();
        await page.getByRole("button", { name: "Log out" }).click();
    });

    test("take sqlite snapshot", async ({ page }) => {
        await takeSqliteSnapshot(page);
    });
});
