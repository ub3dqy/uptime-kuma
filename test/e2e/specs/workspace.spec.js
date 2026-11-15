import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { io } from "socket.io-client";
import Database from "better-sqlite3";
import { login } from "../util-test";

const unsafeName = 'Sites/Local <img src=x onerror="window.workspaceUnsafe=true">';
let peer;
let upID;
let downID;
let pausedID;
let groupID;

/**
 * Exercise only the isolated local application's authenticated API.
 * @param {object} socket Local test socket
 * @param {string} event Operation name
 * @param {...any} args Operation arguments
 * @returns {Promise<object>} Successful response
 */
async function call(socket, event, ...args) {
    const result = await socket.timeout(10000).emitWithAck(event, ...args);
    expect(result.ok, `${event} was refused`).toBe(true);
    return result;
}

/**
 * @param {import('@playwright/test').Page} page Browser page
 * @param {string} route Private application route
 * @returns {Promise<void>} An authenticated page
 */
async function open(page, route = "/dashboard") {
    await page.goto(route);
    await page.waitForSelector("input[placeholder='Username'], .workspace-account");
    if (await page.getByPlaceholder("Username").isVisible()) {
        await login(page);
    }
    await expect(page.locator(".workspace-account")).toBeVisible();
}

test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(60000);
    peer = createServer((request, response) => {
        response.writeHead(request.url.startsWith("/missing") ? 404 : 200, { "Content-Type": "text/plain" });
        response.end("Owned local monitoring fixture");
    });
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const socket = io(baseURL, { transports: ["websocket"], autoConnect: false, reconnection: false });
    try {
        await new Promise((resolve, reject) => {
            socket.once("info", () => setTimeout(resolve, 100));
            socket.once("connect_error", reject);
            socket.connect();
        });
        const needSetup = await socket.timeout(10000).emitWithAck("needSetup");
        if (needSetup) {
            await call(socket, "setup", "admin", "admin123");
        }
        await call(socket, "login", { username: "admin", password: "admin123", token: "" });
        const settings = await call(socket, "getSettings");
        await call(socket, "setSettings", { ...settings.data, nscd: false }, null);
        let liveEvidence;
        socket.on("heartbeat", (beat) => {
            if (beat.monitorID === upID) {
                liveEvidence = beat;
            }
        });
        const add = async (name, url, active = true) => {
            const result = await call(socket, "add", {
                type: "http",
                name,
                url,
                active,
                interval: 20,
                retryInterval: 20,
                timeout: 5,
                maxretries: 0,
                accepted_statuscodes: ["200-299"],
                notificationIDList: {},
                method: "GET",
                conditions: [],
                kafkaProducerBrokers: [],
                kafkaProducerSaslOptions: {},
                rabbitmqNodes: [],
            });
            return result.monitorID;
        };
        const host = `127.0.0.1:${peer.address().port}`;
        upID = await add(unsafeName, `http://fixture-user:fixture-password@${host}/up?token=fixture-query`);
        downID = await add("Sites/Needs attention", `http://${host}/missing`);
        pausedID = await add("Sites/Paused service", `http://${host}/up`, false);
        await add("Pilot/Local demo", "http://canary:8080/always-up", false);
        const group = await call(socket, "saveClientGroup", { name: "Workspace only", monitorIDs: [upID] });
        groupID = group.client.id;
        await expect.poll(() => liveEvidence?.check_session, { timeout: 25000 }).toEqual(expect.any(String));
        expect(liveEvidence.check_interval).toBe(20);
        const db = new Database(process.env.KUMA_E2E_DB_PATH || "data/playwright-test/kuma.db", {
            fileMustExist: true,
            readonly: true,
        });
        try {
            const saved = db
                .prepare("SELECT check_interval, check_session FROM heartbeat WHERE monitor_id = ? AND time = ?")
                .get(upID, liveEvidence.time);
            expect(saved).toEqual({ check_interval: 20, check_session: liveEvidence.check_session });
        } finally {
            db.close();
        }
    } finally {
        socket.disconnect();
    }
});

test.afterAll(async () => {
    await new Promise((resolve) => peer.close(resolve));
});

test("shows actual states, safe addresses, group scope and useful search", async ({ page }) => {
    await open(page);
    const up = page.getByTestId(`service-row-${upID}`);
    const down = page.getByTestId(`service-row-${downID}`);
    await expect(up.locator(".ws-state")).toHaveText("Working", { timeout: 20000 });
    await expect(down.locator(".ws-state")).toHaveText("Unavailable", { timeout: 20000 });
    await expect(down).toContainText("Page not found (404)");
    await expect(page.getByTestId(`service-row-${pausedID}`).locator(".ws-state")).toHaveText("Paused");
    await expect(up.locator("img")).toHaveCount(0);
    await expect(up).toContainText('Local <img src=x onerror="window.workspaceUnsafe=true">');
    await expect(up).not.toContainText("fixture-password");
    await expect(up).not.toContainText("fixture-query");
    expect(await page.evaluate(() => window.workspaceUnsafe)).toBeUndefined();
    await expect(page.locator(".ws-service-row").filter({ hasText: "Pilot/Local demo" })).toHaveCount(0);
    await page.getByRole("searchbox").fill("Needs attention");
    await expect(page.locator(".ws-service-row")).toHaveCount(1);
    await page.getByRole("searchbox").fill("no matching service");
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.locator(".ws-scope select").selectOption(String(groupID));
    await expect(page.locator(".ws-service-row")).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`client=${groupID}`));
    await page.reload();
    await expect(page.locator(".ws-service-row")).toHaveCount(1);
    await page.locator(".ws-scope select").selectOption("all");
    await expect(down).toBeVisible();
    await page.locator(".ws-filters").getByRole("button", { name: "Problems", exact: true }).click();
    await expect(down).toBeVisible();
    await expect(up).toHaveCount(0);
    await expect(page.getByTestId(`service-row-${pausedID}`)).toHaveCount(0);
    await down.click();
    await expect(page.getByTestId("monitor-status")).toHaveText("Down");
});

test("services retain the approved overview design and readable paused checks with complete management controls", async ({ page }, testInfo) => {
    await open(page);
    await page.goto("/list");
    const services = page.getByTestId("workspace-services");
    await expect(services.locator(".ws-summary")).toBeVisible();
    await expect(services.getByTestId("monitoring-lens")).toBeVisible();
    const paused = services.getByTestId(`service-row-${pausedID}`);
    await expect(paused.locator(".ws-state")).toHaveText("Paused");
    await expect.poll(() => paused.evaluate(element => {
        let opacity = 1;
        for (let parent = element; parent; parent = parent.parentElement) {
            opacity *= Number(getComputedStyle(parent).opacity);
        }
        return opacity;
    })).toBe(1);
    await services.locator(".ws-scope select").selectOption(String(groupID));
    await expect(page).toHaveURL(new RegExp(`/list\\?client=${groupID}$`));
    await expect(services.locator(".ws-service-row")).toHaveCount(1);
    await page.reload();
    await expect(services.locator(".ws-service-row")).toHaveCount(1);
    await services.locator(".ws-scope select").selectOption("all");
    await services.getByTestId("service-management-open").click();
    const management = services.getByTestId("service-management");
    const oldPaused = management.locator("a.item.is-paused").filter({ hasText: "Sites/Paused service" });
    await expect(oldPaused.locator(".monitor-paused-label")).toHaveText("Paused");
    await expect.poll(() => oldPaused.evaluate(element => {
        let opacity = 1;
        for (let parent = element; parent; parent = parent.parentElement) {
            opacity *= Number(getComputedStyle(parent).opacity);
        }
        return opacity;
    })).toBe(1);
    await management.locator(".filters-group input[type=checkbox]").check();
    await expect(management.getByRole("button", { name: "Actions", exact: true })).toBeVisible();
    await management.getByRole("button", { name: "Cancel", exact: true }).click();
    await management.locator("summary").click();
    await expect(management.getByTestId("monitor-list")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => localStorage.setItem("theme", theme), theme);
        await page.reload();
        await expect(paused.locator(".ws-state")).toHaveText("Paused");
        for (const width of [360, 768, 1366]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath(`services-${theme}-desktop.png`), fullPage: true });
    }
    await paused.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${pausedID}$`));
});

test("navigation reaches settings, history, monitors and notification forms", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push({ route: page.url(), message: error.message, stack: error.stack }));
    await open(page);
    await page.locator(".workspace-nav").getByRole("link", { name: "Notifications" }).click();
    await expect(page).toHaveURL(/\/notifications$/);
    await page.getByRole("button", { name: "Connect email", exact: true }).click();
    await expect(page.getByTestId("alert-wizard").getByLabel("Mail server", { exact: true })).toBeVisible();
    await page.getByTestId("alert-wizard").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Connect Telegram", exact: true }).click();
    await expect(page.getByTestId("alert-wizard").getByLabel("Bot token", { exact: true })).toBeVisible();
    await page.getByTestId("alert-wizard").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("link", { name: "Advanced notification settings" }).click();
    await expect(page).toHaveURL(/\/settings\/notifications$/);
    await expect(page.getByRole("button", { name: "Connect email", exact: true })).toBeVisible();
    await page.locator(".workspace-nav").getByRole("link", { name: "Reports" }).click();
    await expect(page.locator("#client-name")).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("link", { name: "Event history", exact: true }).click();
    await expect(page).toHaveURL(/\/events$/);
    await expect(page.getByRole("button", { name: "Clear All Events", exact: true })).toBeVisible();
    await page.locator(".workspace-nav").getByRole("link", { name: "Services" }).click();
    await expect(page).toHaveURL(/\/list$/);
    await expect(page.getByTestId("workspace-services")).toBeVisible();
    await page.getByRole("link", { name: "Add service", exact: true }).click();
    await expect(page.getByTestId("monitor-type-select")).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    const settingsLinks = await page
        .locator(".settings-menu a[href]")
        .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    for (const href of settingsLinks) {
        await page.locator(`.settings-menu a[href="${href}"]`).click();
        await expect(page).toHaveURL(new URL(href, page.url()).href);
        await expect(page.locator(".settings-content")).toBeVisible();
        await expect(page.locator(".settings-content")).not.toBeEmpty();
    }
    for (const [name, path] of [
        ["Maintenance", "/maintenance"],
        ["Status Pages", "/manage-status-page"],
        ["About", "/settings/about"],
    ]) {
        await page.getByRole("button", { name: "Account menu" }).click();
        await page.getByRole("link", { name, exact: true }).click();
        await expect(page).toHaveURL(new URL(path, page.url()).href);
        await expect(page.locator("#workspace-main")).not.toBeEmpty();
    }
    expect(errors).toEqual([]);
});

test("connection loss never leaves a successful current state on screen", async ({ page }) => {
    await open(page);
    const up = page.getByTestId(`service-row-${upID}`).locator(".ws-state");
    await expect(up).toHaveText("Working");
    try {
        await page.context().setOffline(true);
        await expect(page.locator(".workspace-connection-banner")).toBeVisible({ timeout: 25000 });
        await expect(up).toHaveText("No data");
        await expect(page.getByTestId(`service-row-${pausedID}`).locator(".ws-state")).toHaveText("Paused");
        await expect(page.locator(".pm-lens.is-connected")).toHaveCount(0);
    } finally {
        await page.context().setOffline(false);
    }
    await expect(up).toHaveText("Working", { timeout: 15000 });
});

test("mobile layout, dark theme, reduced motion and keyboard entry remain usable", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await open(page);
    await expect(page.locator(".workspace-mobile-nav")).toBeVisible();
    await expect(page.locator(".workspace-shell.dark")).toBeVisible();
    await expect(page.locator(".ws-scope select")).toHaveCSS("color", "rgb(231, 239, 249)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator(".pm-lens-flow").evaluate((element) => getComputedStyle(element).animationName)).toBe(
        "none"
    );
    await page.screenshot({ path: testInfo.outputPath("workspace-mobile-dark.png"), fullPage: true });
    await page.locator(".workspace-mobile-nav").getByRole("link", { name: "Notifications" }).click();
    await expect(page.getByRole("button", { name: "Connect Telegram" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 360, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/dashboard");
    await page.keyboard.press("Tab");
    await expect(page.locator(".workspace-skip")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#workspace-main")).toBeFocused();
});

test("private routes require login and logout removes owner information", async ({ page, browser, baseURL }) => {
    const anonymous = await browser.newContext({ locale: "en-US" });
    try {
        const denied = await anonymous.newPage();
        for (const route of ["/dashboard", "/notifications", "/events", "/settings/notifications"]) {
            await denied.goto(baseURL + route);
            await expect(denied.getByPlaceholder("Username")).toBeVisible();
            await expect(denied.locator(".ws-service-row, .ws-alert-choices, .workspace-events")).toHaveCount(0);
        }
    } finally {
        await anonymous.close();
    }
    await open(page);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(page.getByPlaceholder("Username")).toBeVisible();
    await expect(page.locator(".ws-service-row, .workspace-account")).toHaveCount(0);
});

test("overview fits tablet and desktop widths without a horizontal page scrollbar", async ({ page }) => {
    await open(page);
    for (const width of [768, 900, 1366, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator(".workspace-nav")).toBeVisible();
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            `viewport ${width}`
        ).toBe(true);
        await expect(page.getByTestId(`service-row-${upID}`)).toBeVisible();
    }
});

test("monitoring lens moves when connected and expanding a check opens its real observation chart", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await open(page);
    const flow = page.locator(".pm-lens.is-connected .pm-lens-flow");
    await expect(flow).toHaveCSS("animation-name", "pm-signal-flow");
    const before = await flow.evaluate((element) => getComputedStyle(element).strokeDashoffset);
    await expect.poll(() => flow.evaluate((element) => getComputedStyle(element).strokeDashoffset)).not.toBe(before);
    const row = page.getByTestId(`service-row-${upID}`);
    await row.locator("..").getByRole("button").click();
    await expect(page.locator(".pm-service-expanded").getByTestId("observation-chart")).toBeVisible();
    await page.locator(".pm-service-expanded").getByRole("link", { name: "Details and diagnosis" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${upID}$`));
    await expect(page.getByTestId("incident-ai")).toBeVisible();
    await page.getByTestId("incident-ai").getByRole("link", { name: "Connect project AI" }).click();
    await expect(page.getByTestId("project-ai")).toBeVisible();
    await expect(page.getByTestId("ai-automation").getByRole("checkbox", { name: "Start diagnosis after a confirmed failure" })).not.toBeChecked();
});
