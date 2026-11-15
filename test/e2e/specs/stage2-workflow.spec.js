import { expect, test } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ProjectVault } from "../../../server/projects/vault.js";
import { login } from "../util-test";

let peer;
let socket;
let db;
let switchID;
let slowID;
let backupID;
let channelID;
let initialInboxCount;
let personalProjectID;
const ownedIDs = [];
const fixtureFolder = process.env.KUMA_STAGE2_FIXTURE_DIR;

// These steps verify one channel lifecycle and intentionally share saved state.
test.describe.configure({ mode: "serial" });

/**
 * @param {string} event Owned test API operation
 * @param {...any} args Arguments
 * @returns {Promise<object>} Successful response
 */
async function call(event, ...args) {
    const result = await socket.timeout(12000).emitWithAck(event, ...args);
    expect(result.ok, event + " refused").toBe(true);
    return result;
}
/**
 * @param {import('@playwright/test').Page} page Browser page
 * @param {string} route Private route
 * @returns {Promise<void>} Authenticated page
 */
async function open(page, route = "/dashboard") {
    await page.goto(route);
    await page.waitForSelector(".workspace-account, input[placeholder='Username']");
    if (await page.getByPlaceholder("Username").isVisible()) {
        await login(page);
    }
    await expect(page.locator(".workspace-account")).toBeVisible();
}
/**
 * @returns {object[]} Messages received by the owned encrypted fixture, never an external mailbox
 */
function inbox() {
    try {
        return JSON.parse(fs.readFileSync(path.join(fixtureFolder, "messages.json"), "utf8"));
    } catch {
        return [];
    }
}
/**
 * @param {import('@playwright/test').Page} page Browser page
 * @param {string} name Monitor name
 * @returns {Promise<number>} Saved check
 */
async function saveMonitor(page, name) {
    await page.getByTestId("friendly-name-input").fill(name);
    await page.getByTestId("save-button").click();
    await page.waitForURL(/\/dashboard\/\d+$/);
    const id = Number(new URL(page.url()).pathname.split("/").at(-1));
    ownedIDs.push(id);
    return id;
}

test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(60000);
    if (!fixtureFolder) {
        throw new Error("Start the owned stage2-peer fixture first");
    }
    peer = JSON.parse(fs.readFileSync(path.join(fixtureFolder, "fixture.json"), "utf8"));
    expect(peer.synthetic).toBe(true);
    expect(new URL(peer.http).hostname).toBe("127.0.0.1");
    initialInboxCount = inbox().length;
    fs.writeFileSync(path.join(fixtureFolder, "control.json"), JSON.stringify({ mode: "up", rejectMail: false }));
    socket = io(baseURL, { transports: ["websocket"], autoConnect: false, reconnection: false });
    await new Promise((resolve, reject) => {
        socket.once("info", () => setTimeout(resolve, 100));
        socket.once("connect_error", reject);
        socket.connect();
    });
    if (await socket.timeout(10000).emitWithAck("needSetup")) {
        await call("setup", "admin", "admin123");
    }
    await call("login", { username: "admin", password: "admin123", token: "" });
    const ownProject = (await call("projectList", {})).projects.find((project) => project.personal);
    personalProjectID = ownProject.id;
    const ownSnapshot = await call("projectSnapshot", { projectID: ownProject.id });
    await call("projectUpdate", {
        projectID: ownProject.id,
        revision: ownSnapshot.project.revision,
        name: ownSnapshot.project.name,
        timezone: ownSnapshot.project.timezone,
        allowedIPs: ["127.0.0.1"],
    });
    const settings = await call("getSettings");
    await call("setSettings", { ...settings.data, nscd: false, primaryBaseURL: baseURL }, null);
    const defaults = {
        type: "http",
        interval: 20,
        retryInterval: 20,
        timeout: 5,
        maxretries: 0,
        active: true,
        accepted_statuscodes: ["200-299"],
        notificationIDList: {},
        method: "GET",
        conditions: [],
        kafkaProducerBrokers: [],
        kafkaProducerSaslOptions: {},
        rabbitmqNodes: [],
        domainExpiryNotification: false,
    };
    switchID = (
        await call("add", {
            ...defaults,
            name: "Stage2 controlled site",
            url: peer.http + "/switch?token=private-query",
        })
    ).monitorID;
    slowID = (
        await call("add", {
            ...defaults,
            name: "Stage2 slow response",
            url: peer.http + "/slow",
            max_response_time: 10,
        })
    ).monitorID;
    ownedIDs.push(switchID, slowID);
    db = new Database(process.env.KUMA_E2E_DB_PATH, { fileMustExist: true });
});
test.afterAll(async () => {
    if (socket?.connected) {
        for (const id of ownedIDs) {
            await call("pauseMonitor", id);
        }
        socket.disconnect();
    }
    db?.close();
});

test("a slow successful HTTP response is a failure with an understandable card and no signed URL exposure", async ({
    page,
}, testInfo) => {
    await open(page, `/dashboard/${slowID}`);
    const card = page.getByTestId("incident-card");
    await expect(card.getByRole("heading", { name: "A failure is confirmed" })).toBeVisible({ timeout: 20000 });
    await expect(card).toContainText("more slowly");
    await expect(card).toContainText("10 ms");
    await expect(card).toContainText("Exact incident start and duration cannot be established");
    await expect(page.getByTestId("monitor-status")).toHaveText("Down");
    await expect(page.locator(".url")).not.toContainText("private-query");
    await page.setViewportSize({ width: 390, height: 844 });
    // The retained chart resizes asynchronously after the viewport changes.
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("incident-card-mobile.png"), fullPage: true });
    await card.getByRole("link", { name: "Notifications for this service" }).click();
    await page.getByRole("button", { name: "Connect Telegram", exact: true }).click();
    const wizard = page.getByTestId("alert-wizard");
    await expect(wizard.getByLabel("Bot token", { exact: true })).toBeVisible();
    await expect(wizard.getByLabel("Recipient chat ID or channel username")).toBeVisible();
});

test("guided encrypted mail setup assigns selected checks, separates submission from receipt and preserves secrets on edits", async ({
    page,
}) => {
    await open(page, `/notifications?monitor=${switchID}`);
    await page.getByRole("button", { name: "Connect email", exact: true }).click();
    const wizard = page.getByTestId("alert-wizard");
    await wizard.getByLabel("Friendly Name", { exact: true }).fill("Stage2 mail");
    await wizard.getByLabel("Mail server", { exact: true }).fill("127.0.0.1");
    await wizard.getByLabel("Port", { exact: true }).fill(String(peer.smtpPort));
    await wizard.getByLabel("Username", { exact: true }).fill("synthetic-owner");
    await wizard.getByLabel("Password", { exact: true }).fill("fixture-test-password");
    await wizard.getByLabel("Sender address", { exact: true }).fill("stage2-from@example.test");
    await wizard.getByLabel("Recipient address", { exact: true }).fill("stage2-inbox@example.test");
    await wizard.getByRole("button", { name: "Choose services", exact: true }).click();
    await expect(wizard.getByRole("checkbox", { name: "Stage2 controlled site", exact: true })).toBeChecked();
    await wizard.getByRole("button", { name: "Save channel and selection", exact: true }).click();
    await expect(wizard.getByText("Settings saved. No test has been sent.", { exact: true })).toBeVisible();
    expect(inbox().length).toBe(initialInboxCount);
    channelID = db.prepare("SELECT id FROM notification WHERE name = ?").get("Stage2 mail").id;
    expect(db.prepare("SELECT monitor_id FROM monitor_notification WHERE notification_id = ?").all(channelID)).toEqual([
        { monitor_id: switchID },
    ]);
    await wizard.getByRole("button", { name: "Send test message", exact: true }).click();
    await expect(wizard.getByTestId("notification-test-state")).toContainText("Accepted by sending service", {
        timeout: 20000,
    });
    expect(inbox().length).toBe(initialInboxCount + 1);
    expect(inbox()[initialInboxCount].recipient).toContain("stage2-inbox@example.test");
    expect(
        db.prepare("SELECT confirmed_at FROM notification_delivery WHERE notification_id = ?").get(channelID)
            .confirmed_at
    ).toBe(null);
    await wizard.getByRole("button", { name: "I received the message", exact: true }).click();
    await expect(wizard.getByTestId("notification-test-state")).toContainText("Receipt confirmed by you");
    await wizard.getByRole("button", { name: "Done", exact: true }).click();
    const channelRow = page.locator(".notification-list li").filter({ hasText: "Stage2 mail" });
    await expect(channelRow).toContainText("Receipt confirmed by you");
    await channelRow.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(wizard.getByLabel("Password", { exact: true })).toHaveValue("");
    await wizard.getByLabel("Recipient address", { exact: true }).fill("stage2-updated@example.test");
    await wizard.getByRole("button", { name: "Choose services", exact: true }).click();
    await wizard.getByRole("button", { name: "Save channel and selection", exact: true }).click();
    await expect(wizard.getByText("Settings saved. No test has been sent.", { exact: true })).toBeVisible();
    const saved = db.prepare("SELECT config FROM notification WHERE id = ?").get(channelID).config;
    expect(saved).not.toContain("fixture-test-password");
    const envelope = JSON.parse(saved).projectEncryption;
    const vault = new ProjectVault(
        path.join(path.dirname(process.env.KUMA_E2E_DB_PATH), "project-secrets/keys.json"),
        true
    );
    expect(vault.open(envelope.projectID, envelope.cipher, "notification").smtpPassword).toBe("fixture-test-password");
});

test("failure and recovery notifications are recorded and actually reach the local encrypted inbox", async ({
    page,
}) => {
    test.setTimeout(90000);
    await open(page, `/dashboard/${switchID}`);
    const before = inbox().length;
    fs.writeFileSync(path.join(fixtureFolder, "control.json"), JSON.stringify({ mode: "down", rejectMail: false }));
    await expect(page.getByTestId("incident-card")).toContainText("Page not found (404)", { timeout: 35000 });
    await expect
        .poll(
            () =>
                db
                    .prepare(
                        "SELECT status FROM notification_delivery WHERE notification_id = ? AND kind = 'down' ORDER BY id DESC LIMIT 1"
                    )
                    .get(channelID)?.status,
            { timeout: 20000 }
        )
        .toBe("submitted");
    expect(inbox().length).toBeGreaterThan(before);
    expect(inbox().at(-1).body).not.toContain("private-query");
    expect(inbox().at(-1).body).toContain(`/projects/${personalProjectID}?check=${switchID}`);
    await expect(page.getByTestId("incident-card").getByTestId("delivery-history")).toContainText(
        "Accepted by sending service"
    );
    await page.goto(`/projects/${personalProjectID}?check=${switchID}`);
    await expect(page.getByTestId("project-check-details")).toContainText("Stage2 controlled site");
    await page.goto(`/dashboard/${switchID}`);
    fs.writeFileSync(path.join(fixtureFolder, "control.json"), JSON.stringify({ mode: "up", rejectMail: false }));
    await expect(page.getByTestId("incident-card")).toContainText("The latest check succeeded", { timeout: 35000 });
    await expect
        .poll(
            () =>
                db
                    .prepare(
                        "SELECT status FROM notification_delivery WHERE notification_id = ? AND kind = 'up' ORDER BY id DESC LIMIT 1"
                    )
                    .get(channelID)?.status,
            { timeout: 20000 }
        )
        .toBe("submitted");
    await page.goto("/notifications");
    await page
        .locator(".notification-list li")
        .filter({ hasText: "Stage2 mail" })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
    const wizard = page.getByTestId("alert-wizard");
    await wizard.getByRole("button", { name: "Delete", exact: true }).click();
    await wizard.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(db.prepare("SELECT id FROM notification WHERE id = ?").get(channelID)).toBeTruthy();
    await wizard.getByRole("button", { name: "Delete", exact: true }).click();
    await wizard.getByRole("button", { name: "Yes, delete channel", exact: true }).click();
    await expect(wizard).not.toBeVisible();
    expect(db.prepare("SELECT id FROM notification WHERE id = ?").get(channelID)).toBeUndefined();
    expect(db.prepare("SELECT id FROM heartbeat WHERE monitor_id = ? LIMIT 1").get(switchID)).toBeTruthy();
});

test("clear setup presets create working HTTPS, DNS, TCP and backup-report checks without pretending to create a backup", async ({
    page,
    request,
}) => {
    test.setTimeout(90000);
    await open(page, "/add");
    const presets = page.locator(".ws-monitor-presets");
    await presets.getByRole("button", { name: /Certificate/ }).click();
    await page.getByTestId("url-input").fill(peer.https + "/up");
    const tlsID = await saveMonitor(page, "Stage2 local certificate");
    await expect(page.getByTestId("monitor-status")).toHaveText("Up", { timeout: 20000 });
    await expect(page.getByTestId("incident-card")).toContainText("Identity was verified");
    expect(db.prepare("SELECT ignore_tls, expiry_notification FROM monitor WHERE id = ?").get(tlsID)).toEqual({
        ignore_tls: 0,
        expiry_notification: 1,
    });
    await page.goto("/add");
    await presets.getByRole("button", { name: /Domain address/ }).click();
    await expect(page.getByTestId("monitor-type-select")).toHaveValue("dns");
    await page.getByTestId("hostname-input").fill("service.fixture.test");
    await page.locator("#dns_resolve_server").fill("127.0.0.1");
    await page.locator("#port").fill(String(peer.dnsPort));
    await saveMonitor(page, "Stage2 local DNS");
    await expect(page.getByTestId("monitor-status")).toHaveText("Up", { timeout: 20000 });
    await page.goto("/add");
    await presets.getByRole("button", { name: /Service port/ }).click();
    await page.getByTestId("hostname-input").fill("127.0.0.1");
    await page.locator("#port").fill(String(new URL(peer.http).port));
    await saveMonitor(page, "Stage2 local port");
    await expect(page.getByTestId("monitor-status")).toHaveText("Up", { timeout: 20000 });
    await page.goto("/add");
    await presets.getByRole("button", { name: /Backup report/ }).click();
    await expect(presets).toContainText("does not create or inspect backups");
    backupID = await saveMonitor(page, "Stage2 synthetic backup report");
    expect(db.prepare("SELECT interval FROM monitor WHERE id = ?").get(backupID).interval).toBe(86400);
    const token = db.prepare("SELECT push_token FROM monitor WHERE id = ?").get(backupID).push_token;
    const pushed = await request.get(`/api/push/${token}?status=up&msg=synthetic-verified-backup`);
    expect(pushed.ok()).toBe(true);
    await expect(page.getByTestId("monitor-status")).toHaveText("Up", { timeout: 15000 });
});
