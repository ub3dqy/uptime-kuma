import { expect, test } from "@playwright/test";
import fs from "fs/promises";
import { login } from "../util-test";

/**
 * Create a monitor that checks only this isolated local test server.
 * @param {Page} page Browser page
 * @param {string} baseURL Local test URL
 * @returns {Promise<void>}
 */
async function createMonitor(page, baseURL) {
    await page.goto("./add");
    await login(page);
    await page.getByTestId("monitor-type-select").selectOption("http");
    await page.getByTestId("friendly-name-input").fill('=Report, "Тест"');
    await page.getByTestId("url-input").fill(baseURL);
    await page.getByTestId("save-button").click();
    await page.waitForURL("/dashboard/*");
    await expect(page.getByTestId("monitor-status")).toHaveText("Up", { timeout: 20000 });
}

test.describe("Retained history CSV", () => {
    test.beforeAll(async ({ browser, baseURL }) => {
        const page = await browser.newPage({ locale: "en-US" });
        page.on("pageerror", (error) => console.error("Browser startup:", error.message));
        await page.goto(baseURL);
        await page.waitForSelector("form, [data-testid='monitor-list']");
        if (await page.getByText("SQLite", { exact: true }).isVisible()) {
            await page.getByText("SQLite", { exact: true }).click();
            await page.getByRole("button", { name: "Next", exact: true }).click();
            await page.getByPlaceholder("Username").waitFor();
        }
        if (await page.getByPlaceholder("Repeat Password").isVisible()) {
            await page.getByPlaceholder("Username").fill("admin");
            await page.getByPlaceholder("Password", { exact: true }).fill("admin123");
            await page.getByPlaceholder("Repeat Password").fill("admin123");
            await page.getByRole("button", { name: "Create", exact: true }).click();
        } else if (await page.getByPlaceholder("Username").isVisible()) {
            await login(page);
        }
        await expect(page.getByTestId("monitor-list")).toBeVisible();
        await page.close();
    });

    test("downloads an owner-authenticated CSV with real observations", async ({ page, baseURL }, testInfo) => {
        await createMonitor(page, baseURL);
        await page.locator("#export-history-start").fill(new Date(Date.now() - 3600000).toISOString().slice(0, 16));
        // The next minute includes the newly created heartbeat, within server clock tolerance.
        await page
            .locator("#export-history-end")
            .fill(new Date(Math.ceil(Date.now() / 60000) * 60000).toISOString().slice(0, 16));
        const downloadPromise = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download CSV", exact: true }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/^monitor-\d+-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
        const csv = await fs.readFile(await download.path(), "utf8");
        expect(csv).toContain("monitor_id,monitor_name,time_utc,status,ping_ms,duration_seconds,message");
        expect(csv).toContain('"\'=Report, ""Тест"""');
        expect(csv).toContain('"UP"');
        await page.screenshot({ path: testInfo.outputPath("history-export-desktop.png"), fullPage: true });
    });

    test("explains empty retained history without downloading a misleading file", async ({ page, baseURL }) => {
        await createMonitor(page, baseURL);
        await page.locator("#export-history-start").fill("2026-01-01T00:00");
        await page.locator("#export-history-end").fill("2026-01-02T00:00");
        await page.getByRole("button", { name: "Download CSV", exact: true }).click();
        await expect(page.locator("section[aria-labelledby='export-history-title']").getByRole("status")).toHaveText(
            "No retained checks were found in this period."
        );
    });

    test("shows validation errors and fits a narrow screen", async ({ page, baseURL }, testInfo) => {
        await createMonitor(page, baseURL);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator("#export-history-start").fill("2026-01-02T00:00");
        await page.locator("#export-history-end").fill("2026-01-01T00:00");
        await page.getByRole("button", { name: "Download CSV", exact: true }).click();
        await expect(page.locator("section[aria-labelledby='export-history-title']").getByRole("alert")).toContainText(
            "Choose a valid UTC range"
        );
        const width = await page
            .locator("section[aria-labelledby='export-history-title']")
            .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(width.scroll).toBeLessThanOrEqual(width.client);
        await page.screenshot({ path: testInfo.outputPath("history-export-mobile.png"), fullPage: true });
    });

    test("shows the export and validation messages in Russian", async ({ page, baseURL }, testInfo) => {
        await createMonitor(page, baseURL);
        await page.evaluate(() => localStorage.setItem("locale", "ru-RU"));
        await page.reload();
        await expect(page.getByRole("heading", { name: "Выгрузка истории проверок" })).toBeVisible();
        await page.locator("#export-history-start").fill("2026-01-02T00:00");
        await page.locator("#export-history-end").fill("2026-01-01T00:00");
        await page.getByRole("button", { name: "Скачать CSV", exact: true }).click();
        await expect(page.locator("section[aria-labelledby='export-history-title']").getByRole("alert")).toContainText(
            "Выберите корректный период"
        );
        await page
            .locator("section[aria-labelledby='export-history-title']")
            .screenshot({ path: testInfo.outputPath("history-export-russian.png") });
    });

    test("preserves formatted descriptions while removing executable HTML", async ({ page, baseURL }) => {
        await createMonitor(page, baseURL);
        const monitorURL = page.url();
        await page.getByRole("link", { name: "Edit", exact: true }).click();
        await page
            .locator("#description")
            .fill(
                '**Safe description** <img src="/invalid-test-image" onerror="window.kumaUnsafeHTML=true">' +
                    '<script>window.kumaUnsafeHTML=true</script><a href="javascript:window.kumaUnsafeHTML=true">unsafe link</a>'
            );
        await page.getByTestId("save-button").click();
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await page.goto(monitorURL);
        await expect(page.locator("strong").filter({ hasText: "Safe description" })).toBeVisible();
        const description = page.locator("p").filter({ hasText: "Safe description" }).last();
        await expect(description.locator("script, [onerror], a[href^='javascript:']")).toHaveCount(0);
        expect(await page.evaluate(() => window.kumaUnsafeHTML)).toBeUndefined();
        await page.locator("header [data-bs-toggle='dropdown']").click();
        await expect(page.locator("header .dropdown-menu")).toBeVisible();
        await expect(
            page.locator("header .dropdown-menu").getByRole("link", { name: "Settings", exact: true })
        ).toBeVisible();
    });

    test("the maintained editor saves status-page CSS and editable titles", async ({ page }) => {
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("./add-status-page");
        await login(page);
        await page.getByTestId("name-input").fill("Dependency upgrade");
        await page.getByTestId("slug-input").fill("dependency-upgrade");
        await page.getByTestId("submit-button").click();
        await page.waitForURL(/\/status\/dependency-upgrade(?:\?.*)?$/);
        const edit = page.getByTestId("edit-button");
        if (await edit.isVisible()) {
            await edit.click();
        }
        const editor = page.getByTestId("custom-css-input").locator("textarea");
        await editor.fill("body { --upgrade-proof: 42; }");
        await page.locator("h1 [contenteditable=true]").fill("Updated title");
        await page.getByTestId("save-button").click();
        await expect(page.getByRole("heading", { name: "Updated title", exact: true })).toBeVisible();
        await expect
            .poll(() => page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--upgrade-proof").trim()))
            .toBe("42");
        await page.getByTestId("edit-button").click();
        await expect(editor).toHaveValue("body { --upgrade-proof: 42; }");
        expect(errors).toEqual([]);
    });

    test("push examples remain highlighted and read only", async ({ page }) => {
        await page.goto("./add");
        await login(page);
        await page.getByTestId("monitor-type-select").selectOption("push");
        await page.getByTestId("friendly-name-input").fill("Push editor check");
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*");
        if (!(await page.locator("#push-current-example").isVisible())) {
            await page.getByText("How to use Push monitor? (View Code)", { exact: true }).click();
        }
        await page.locator("#push-current-example").selectOption("javascript-fetch");
        const editor = page.locator(".code-editor textarea");
        await expect(editor).toHaveAttribute("readonly", "");
        await expect(editor).toHaveValue(/fetch/);
        await expect(page.locator(".code-editor .token").first()).toBeAttached();
    });

    test("current date pickers open and metrics keep authentication", async ({ page, request }) => {
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("./add-maintenance");
        await login(page);
        await expect(page.locator('input[type="datetime-local"]').first()).not.toHaveValue("");
        await page.locator("#strategy").selectOption("recurring-interval");
        await page.locator(".dp--input").click();
        await expect(page.locator(".dp--menu")).toBeVisible();
        await page.keyboard.press("Escape");
        await page.goto("./settings/api-keys");
        await page.getByRole("button", { name: "Add API Key", exact: true }).click();
        const modal = page.locator(".modal.show");
        await modal.locator(".dp--input").click();
        await expect(modal.locator(".dp--menu")).toBeVisible();
        expect((await request.get("/metrics")).status()).toBe(401);
        const response = await request.get("/metrics", {
            headers: { Authorization: "Basic " + Buffer.from("admin:admin123").toString("base64") },
        });
        expect(response.status()).toBe(200);
        const metrics = await response.text();
        expect(metrics).toContain("monitor_status");
        expect(metrics).toContain("process_cpu_user_seconds_total");
        expect(errors).toEqual([]);
    });
});
