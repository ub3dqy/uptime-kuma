import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { login } from "../util-test";

const databasePath = process.env.KUMA_E2E_DB_PATH || "data/playwright-test/kuma.db";

/**
 * @param {Page} page Browser page
 * @param {string} baseURL Owned local test server
 * @param {string} name Monitor name
 * @returns {Promise<number>} New monitor ID
 */
async function createMonitor(page, baseURL, name) {
    await page.goto("./add");
    await page.waitForSelector("[data-testid='monitor-type-select'], input[placeholder='Username']");
    if (await page.getByPlaceholder("Username").isVisible()) {
        await login(page);
    }
    await page.getByTestId("monitor-type-select").selectOption("http");
    await page.getByTestId("friendly-name-input").fill(name);
    await page.getByTestId("url-input").fill(baseURL);
    await page.getByTestId("save-button").click();
    await page.waitForURL("/dashboard/*");
    await expect(page.getByTestId("monitor-status")).toHaveText("Up", { timeout: 20000 });
    return Number(new URL(page.url()).pathname.split("/").at(-1));
}

/**
 * @param {Page} page Browser page
 * @returns {Promise<void>} A ready, authenticated client editor
 */
async function clientsPage(page) {
    await page.goto("./clients");
    await page.waitForSelector("#client-name, input[placeholder='Username']");
    if (await page.getByPlaceholder("Username").isVisible()) {
        await login(page);
    }
    await expect(page.getByRole("button", { name: "New client group", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
}

test.describe("Client groups and printable reports", () => {
    test.beforeAll(async ({ browser, baseURL }) => {
        const page = await browser.newPage({ locale: "en-US" });
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

    test("saves selected checks, reports weighted time and deletes only the grouping", async ({ page, baseURL }) => {
        const first = await createMonitor(page, baseURL, "Client site A");
        const second = await createMonitor(page, baseURL, "Client site B");
        const name = 'Client <img src=x onerror="window.unsafeClient=true">';
        const db = new Database(databasePath, { fileMustExist: true });
        try {
            const insert = db.prepare(
                "INSERT INTO heartbeat (monitor_id, time, status, ping, check_interval, check_session, important) VALUES (?, ?, ?, ?, ?, ?, 1)"
            );
            insert.run(first, "2026-10-01 00:00:00.000", 1, 0, 60, "client-a");
            insert.run(first, "2026-10-01 00:01:00.000", 1, 15, 60, "client-a");
            insert.run(second, "2026-10-01 00:00:00.000", 0, null, 300, "client-b");
            insert.run(second, "2026-10-01 00:05:00.000", 0, null, 300, "client-b");
            await clientsPage(page);
            await page.locator("#client-name").fill(name);
            await page.locator("#client-monitor-" + first).check();
            await page.locator("#client-monitor-" + second).check();
            await page.getByRole("button", { name: "Save", exact: true }).click();
            await expect(page.getByRole("status")).toHaveText("Saved.");
            const client = db.prepare("SELECT id FROM client_group WHERE name = ?").get(name);
            await page.reload();
            await page.getByRole("button", { name: name + " (2)", exact: true }).click();
            await expect(page.locator("#client-monitor-" + first)).toBeChecked();
            await page.locator("#client-report-start").fill("2026-10-01T00:00");
            await page.locator("#client-report-end").fill("2026-10-01T00:05");
            await page.getByRole("button", { name: "Open period report", exact: true }).click();
            const report = page.getByTestId("client-report");
            await expect(report.getByTestId("summary-availability")).toHaveText("16.67%");
            await expect(report.getByTestId("summary-coverage")).toHaveText("60%");
            await expect(report.getByTestId("summary-unknown")).toContainText("4 min");
            await expect(report.getByTestId("client-report-monitor")).toHaveCount(2);
            await expect(report.locator("h1 img")).toHaveCount(0);
            expect(await page.evaluate(() => window.unsafeClient)).toBeUndefined();
            await page.getByRole("link", { name: "Clients", exact: true }).click();
            await page.getByRole("button", { name: name + " (2)", exact: true }).click();
            await page.getByRole("button", { name: "Delete client group", exact: true }).click();
            await page.getByRole("button", { name: "Delete grouping only", exact: true }).click();
            await expect(page.getByRole("button", { name: name + " (2)", exact: true })).toHaveCount(0);
            expect(db.prepare("SELECT COUNT(*) AS n FROM monitor WHERE id IN (?, ?)").get(first, second).n).toBe(2);
            expect(
                db.prepare("SELECT COUNT(*) AS n FROM heartbeat WHERE monitor_id IN (?, ?)").get(first, second).n
            ).toBeGreaterThanOrEqual(4);
            expect(db.prepare("SELECT id FROM client_group WHERE id = ?").get(client.id)).toBeUndefined();
        } finally {
            db.close();
        }
    });

    test("keeps empty reports unknown, refuses stale editors and requires login for direct report URLs", async ({
        page,
        browser,
    }) => {
        await clientsPage(page);
        await page.locator("#client-name").fill("Two editors");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("status")).toHaveText("Saved.");
        const second = await page.context().newPage();
        await clientsPage(second);
        await second.getByRole("button", { name: "Two editors (0)", exact: true }).click();
        await page.locator("#client-report-start").fill("2026-10-01T00:00");
        await page.locator("#client-report-end").fill("2026-10-01T00:05");
        await page.getByRole("button", { name: "Open period report", exact: true }).click();
        await expect(page.getByTestId("summary-availability")).toHaveText("No data");
        await expect(page.getByTestId("summary-coverage")).toHaveText("No data");
        const directURL = page.url();
        const anonymous = await browser.newContext();
        const denied = await anonymous.newPage();
        await denied.goto(directURL);
        await expect(denied.getByPlaceholder("Username")).toBeVisible();
        await expect(denied.getByTestId("client-report")).toHaveCount(0);
        await expect(denied.getByRole("button", { name: "Print / save PDF" })).toBeDisabled();
        await anonymous.close();
        await page.getByRole("link", { name: "Clients", exact: true }).click();
        await page.getByRole("button", { name: "Two editors (0)", exact: true }).click();
        await page.locator("#client-name").fill("Current edit");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("status")).toHaveText("Saved.");
        await second.locator("#client-name").fill("Stale edit");
        await second.getByRole("button", { name: "Save", exact: true }).click();
        await expect(second.getByRole("alert")).toContainText("changed");
        await second.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect(second.locator("#client-name")).toHaveValue("Current edit");
        await second.close();
    });

    test("prints a Russian client report across pages without controls or secrets", async ({ page }, testInfo) => {
        test.setTimeout(60000);
        await clientsPage(page);
        const db = new Database(databasePath, { fileMustExist: true });
        let clientID;
        try {
            const { user_id: userID } = db.prepare("SELECT user_id FROM monitor ORDER BY id LIMIT 1").get();
            clientID = Number(
                db
                    .prepare("INSERT INTO client_group (user_id, name, revision) VALUES (?, ?, 1)")
                    .run(userID, "Проверка печати — тестовый клиент").lastInsertRowid
            );
            const insert = db.prepare("INSERT INTO monitor (user_id, name, type, active) VALUES (?, ?, 'http', 0)");
            const member = db.prepare("INSERT INTO client_group_monitor (client_group_id, monitor_id) VALUES (?, ?)");
            for (let index = 1; index <= 20; index++) {
                const monitorID = Number(
                    insert.run(
                        userID,
                        `Сервис ${String(index).padStart(2, "0")} — проверка переноса таблицы с длинным названием`
                    ).lastInsertRowid
                );
                member.run(clientID, monitorID);
            }
        } finally {
            db.close();
        }
        await page.evaluate(() => {
            localStorage.setItem("locale", "ru-RU");
            localStorage.setItem("theme", "dark");
        });
        const query = new URLSearchParams({
            revision: "1",
            start: "2026-10-01T00:00:00.000Z",
            end: "2026-10-01T00:05:00.000Z",
        });
        await page.goto(`./client-report/${clientID}?${query}`);
        const report = page.getByTestId("client-report");
        await expect(report.getByTestId("client-report-monitor")).toHaveCount(20);
        await expect(report.getByTestId("summary-coverage")).toHaveText(/0\s?%/);
        await page.setViewportSize({ width: 390, height: 844 });
        const width = await page
            .locator(".client-report-page")
            .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(width.scroll).toBeLessThanOrEqual(width.client);
        await page.screenshot({ path: testInfo.outputPath("client-report-russian-mobile.png"), fullPage: true });
        await page.evaluate(() => {
            window.print = () => {
                window.clientPrintCalls = (window.clientPrintCalls || 0) + 1;
            };
        });
        await page.getByRole("button", { name: "Печать / сохранить PDF", exact: true }).click();
        expect(await page.evaluate(() => window.clientPrintCalls)).toBe(1);
        await page.emulateMedia({ media: "print" });
        await expect(page.locator(".report-tools")).toBeHidden();
        const output = process.env.KUMA_CLIENT_PDF_PATH || testInfo.outputPath("client-report-russian.pdf");
        fs.mkdirSync(path.dirname(output), { recursive: true });
        await page.pdf({ path: output, format: "A4", preferCSSPageSize: true, printBackground: true });
    });
});
