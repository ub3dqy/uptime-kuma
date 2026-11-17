import { expect, test } from "@playwright/test";
import fs from "fs/promises";
import Database from "better-sqlite3";
import { e2eOwnerPassword, getSetupCode, login } from "../util-test";

const databasePath = process.env.KUMA_E2E_DB_PATH || "data/playwright-test/kuma.db";

/**
 * Pause through the same confirmation used by the owner.
 * @param {Page} page Browser page
 * @returns {Promise<void>}
 */
async function pauseMonitor(page) {
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.locator(".modal.show")).toHaveCSS("opacity", "1");
    await page.locator(".modal.show").getByRole("button", { name: "Yes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(page.locator(".modal.show")).toHaveCount(0);
}

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
            await page.getByLabel("Installation code").fill(getSetupCode());
            await page.getByRole("button", { name: "Next", exact: true }).click();
            await page.getByPlaceholder("Username").waitFor();
        }
        if (await page.getByPlaceholder("Repeat Password").isVisible()) {
            await page.getByPlaceholder("Username").fill("admin");
            if (await page.getByLabel("Installation code").isVisible()) {
                await page.getByLabel("Installation code").fill(getSetupCode());
            }
            await page.getByPlaceholder("Password", { exact: true }).fill(e2eOwnerPassword);
            await page.getByPlaceholder("Repeat Password").fill(e2eOwnerPassword);
            await page.getByRole("button", { name: "Create account", exact: true }).click();
            await page.waitForURL("/start");
            await page.goto("/dashboard");
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

    test("summarizes a real history gap without granting uptime and preserves run boundaries", async ({
        page,
        baseURL,
    }, testInfo) => {
        await createMonitor(page, baseURL);
        const monitorID = Number(new URL(page.url()).pathname.split("/").at(-1));
        // This spec runs against the isolated local database created by the Playwright webServer.
        const db = new Database(databasePath, { fileMustExist: true });
        db.pragma("busy_timeout = 5000");
        try {
            const latest = db.prepare(
                "SELECT check_interval, check_session FROM heartbeat WHERE monitor_id = ? ORDER BY id DESC LIMIT 1"
            );
            await expect.poll(() => latest.get(monitorID)?.check_session).toMatch(/^[a-f0-9-]{36}$/);
            const initial = latest.get(monitorID);
            expect(initial.check_interval).toBe(60);
            await pauseMonitor(page);
            await page.getByRole("button", { name: "Resume", exact: true }).click();
            await expect.poll(() => latest.get(monitorID)?.check_session).not.toBe(initial.check_session);
            await pauseMonitor(page);
            const insert =
                db.prepare(`INSERT INTO heartbeat (monitor_id, time, status, ping, check_interval, check_session)
                VALUES (?, ?, ?, ?, ?, ?)`);
            db.transaction(() => {
                for (const [minute, status, ping] of [
                    [0, 1, 0],
                    [1, 1, 10],
                    [5, 0, null],
                    [6, 0, null],
                    [8, 1, 30],
                    [9, 1, 40],
                    [10, 1, 999],
                ]) {
                    insert.run(
                        monitorID,
                        `2026-01-01 00:${String(minute).padStart(2, "0")}:00.000`,
                        status,
                        ping,
                        60,
                        "fixture-run"
                    );
                }
            })();
            await page.locator("#export-history-start").fill("2026-01-01T00:00");
            await page.locator("#export-history-end").fill("2026-01-01T00:10");
            await page.getByRole("button", { name: "Calculate summary", exact: true }).click();
            const summary = page.getByTestId("period-summary");
            await expect(summary.getByTestId("summary-availability")).toHaveText("66.67%");
            await expect(summary.getByTestId("summary-coverage")).toHaveText("60%");
            await expect(summary.getByTestId("summary-unknown")).toContainText("4 min");
            await expect(summary.getByTestId("summary-down")).toContainText("2 min");
            await expect(summary.getByTestId("summary-response")).toContainText("20 ms");
            await summary.screenshot({ path: testInfo.outputPath("period-summary-desktop.png") });
            // A changed period must not keep showing a stale summary.
            await page.locator("#export-history-end").fill("2026-01-01T00:09");
            await expect(summary).toHaveCount(0);
            await page.evaluate(() => localStorage.setItem("locale", "ru-RU"));
            await page.reload();
            await page.setViewportSize({ width: 390, height: 844 });
            await page.locator("#export-history-start").fill("2026-01-01T00:00");
            await page.locator("#export-history-end").fill("2026-01-01T00:10");
            await page.getByRole("button", { name: "Рассчитать сводку", exact: true }).click();
            await expect(summary.getByRole("heading", { name: "Сводка за период" })).toBeVisible();
            await expect(summary.getByTestId("summary-coverage")).toHaveText(/60\s?%/);
            const width = await summary.evaluate((element) => ({
                scroll: element.scrollWidth,
                client: element.clientWidth,
            }));
            expect(width.scroll).toBeLessThanOrEqual(width.client);
            await summary.screenshot({ path: testInfo.outputPath("period-summary-russian-mobile.png") });
        } finally {
            db.close();
        }
    });

    test("keeps legacy history unknown and displays an empty summary with no availability", async ({
        page,
        baseURL,
    }) => {
        await createMonitor(page, baseURL);
        const monitorID = Number(new URL(page.url()).pathname.split("/").at(-1));
        const db = new Database(databasePath, { fileMustExist: true });
        try {
            const insert = db.prepare("INSERT INTO heartbeat (monitor_id, time, status, ping) VALUES (?, ?, 1, 15)");
            insert.run(monitorID, "2026-01-01 00:00:00.000");
            insert.run(monitorID, "2026-01-01 00:01:00.000");
        } finally {
            db.close();
        }
        await page.locator("#export-history-start").fill("2026-01-01T00:00");
        await page.locator("#export-history-end").fill("2026-01-01T00:10");
        await page.getByRole("button", { name: "Calculate summary", exact: true }).click();
        const summary = page.getByTestId("period-summary");
        await expect(summary.getByTestId("summary-availability")).toHaveText("No data");
        await expect(summary.getByTestId("summary-coverage")).toHaveText("0%");
        await expect(summary.getByRole("status")).toContainText("Some checks have no saved schedule");
        await page.locator("#export-history-start").fill("2025-12-01T00:00");
        await page.locator("#export-history-end").fill("2025-12-01T00:10");
        await page.getByRole("button", { name: "Calculate summary", exact: true }).click();
        await expect(summary.getByRole("status")).toHaveText("No saved checks fall inside this period.");
        await expect(summary.getByTestId("summary-availability")).toHaveText("No data");
        const updated = new Database(databasePath, { fileMustExist: true });
        try {
            updated
                .prepare(
                    "UPDATE heartbeat SET check_interval = 59.999, check_session = 'tiny-gap' WHERE monitor_id = ? AND time = '2026-01-01 00:00:00.000'"
                )
                .run(monitorID);
            updated
                .prepare(
                    "UPDATE heartbeat SET check_interval = 540, check_session = 'tiny-gap' WHERE monitor_id = ? AND time = '2026-01-01 00:01:00.000'"
                )
                .run(monitorID);
            updated
                .prepare(
                    "INSERT INTO heartbeat (monitor_id, time, status, check_interval, check_session) VALUES (?, '2026-01-01 00:10:00.000', 1, 60, 'tiny-gap')"
                )
                .run(monitorID);
        } finally {
            updated.close();
        }
        await page.locator("#export-history-start").fill("2026-01-01T00:00");
        await page.locator("#export-history-end").fill("2026-01-01T00:10");
        await page.getByRole("button", { name: "Calculate summary", exact: true }).click();
        await expect(summary.getByTestId("summary-coverage")).toHaveText("< 100%");
        await expect(summary.getByTestId("summary-unknown")).toContainText("0.001 sec");
    });

    test("records push observation intervals and changes their run after a pause", async ({ page, request }) => {
        await page.goto("./add");
        await login(page);
        await page.getByTestId("monitor-type-select").selectOption("push");
        await page.getByTestId("friendly-name-input").fill("Push summary run");
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*");
        const monitorID = Number(new URL(page.url()).pathname.split("/").at(-1));
        const db = new Database(databasePath, { fileMustExist: true });
        try {
            const monitor = db.prepare("SELECT push_token FROM monitor WHERE id = ?").get(monitorID);
            const latest = db.prepare(
                "SELECT check_interval, check_session FROM heartbeat WHERE monitor_id = ? ORDER BY id DESC LIMIT 1"
            );
            expect((await (await request.get(`/api/push/${monitor.push_token}?ping=15`)).json()).ok).toBe(true);
            const initial = latest.get(monitorID);
            expect(initial.check_interval).toBe(60);
            expect(initial.check_session).toMatch(/^[a-f0-9-]{36}$/);
            await pauseMonitor(page);
            await page.getByRole("button", { name: "Resume", exact: true }).click();
            await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
            expect((await (await request.get(`/api/push/${monitor.push_token}?ping=25`)).json()).ok).toBe(true);
            expect(latest.get(monitorID).check_session).not.toBe(initial.check_session);
        } finally {
            db.close();
        }
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
        // Newly created pages enter edit mode asynchronously through ?edit.
        await expect(page.getByTestId("edit-sidebar")).toBeVisible();
        const editor = page.getByTestId("custom-css-input").locator("textarea");
        await editor.fill("body { --upgrade-proof: 42; }");
        await page.locator("h1 [contenteditable=true]").fill("Updated title");
        const reloaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
        await page.getByTestId("save-button").click();
        await reloaded;
        await expect(page.getByRole("heading", { name: "Updated title", exact: true })).toBeVisible();
        await expect(page.locator("body")).toHaveCSS("--upgrade-proof", "42");
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
            headers: { Authorization: "Basic " + Buffer.from("admin:" + e2eOwnerPassword).toString("base64") },
        });
        expect(response.status()).toBe(200);
        const metrics = await response.text();
        expect(metrics).toContain("monitor_status");
        expect(metrics).toContain("process_cpu_user_seconds_total");
        expect(errors).toEqual([]);
    });
});
