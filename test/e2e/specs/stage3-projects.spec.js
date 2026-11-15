import { expect, test } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import notp from "notp";
import base32 from "thirty-two";
const en = JSON.parse(fs.readFileSync(path.resolve("src/lang/en.json"), "utf8"));
const tr = (key) => en[key];
const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
const password = "synthetic-project-password-123";
let owner;
let projectID;
let otherID;
let monitorID;
let peer;
let db;
const people = {};
const sockets = [];
test.describe.configure({ mode: "serial" });
test.beforeEach(() => test.setTimeout(60000));

/**
 * @param {string} baseURL Owned app
 * @returns {Promise<object>} Connected socket
 */
async function connect(baseURL) {
    const socket = io(baseURL, { transports: ["websocket"], reconnection: false, autoConnect: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
        socket.once("info", resolve);
        socket.once("connect_error", reject);
        socket.connect();
    });
    return socket;
}
/**
 * @param {object} socket Human connection
 * @param {string} event Operation
 * @param {...any} args Payload
 * @returns {Promise<object>} Authorized result
 */
async function call(socket, event, ...args) {
    const result = await socket.timeout(12000).emitWithAck(event, ...args);
    expect(result.ok, event + ": " + result.msg).toBe(true);
    return result;
}
/**
 * @param {object} page Page
 * @param {object} person Explicit test identity
 * @param {string} route Route
 * @returns {Promise<void>} Page with a synthetic JWT
 */
async function open(page, person = people.owner, route = "/projects/" + projectID) {
    await page.addInitScript((token) => {
        if (!localStorage.getItem("token")) {
            localStorage.setItem("token", token);
        }
        localStorage.setItem("remember", "1");
        localStorage.setItem("language", "en");
    }, person.token);
    await page.goto(route);
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(page.getByLabel(tr("projectChoose"))).toBeVisible();
}
/** @returns {object[]} Only local synthetic requests */
function requests() {
    return JSON.parse(fs.readFileSync(path.join(folder, "ai-requests.json"), "utf8"));
}

test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(60000);
    peer = JSON.parse(fs.readFileSync(path.join(folder, "fixture.json"), "utf8"));
    fs.writeFileSync(path.join(folder, "control.json"), JSON.stringify({ mode: "up", rejectMail: false }));
    owner = await connect(baseURL);
    if (await owner.timeout(10000).emitWithAck("needSetup")) {
        await call(owner, "setup", "admin", "admin123");
    }
    people.owner = await call(owner, "login", { username: "admin", password: "admin123", token: "" });
    projectID = (
        await call(owner, "projectCreate", {
            name: "Stage3 isolated project",
            timezone: "Europe/Moscow",
            allowedIPs: ["127.0.0.1"],
        })
    ).id;
    otherID = (await call(owner, "projectCreate", { name: "Stage3 unrelated project", timezone: "UTC" })).id;
    for (const role of ["viewer", "operator", "admin"]) {
        const invite = await call(owner, "projectCreateInvite", { projectID, role });
        const socket = await connect(baseURL);
        const username = "stage3-" + role;
        await call(socket, "projectAcceptInvite", { token: invite.token, username, password });
        const logged = await call(socket, "login", { username, password, token: "" });
        people[role] = { ...logged, socket, username };
    }
    monitorID = (
        await call(owner, "projectSaveMonitor", {
            projectID,
            name: "Stage3 controlled website",
            type: "http",
            interval: 20,
            maxretries: 0,
            url: peer.http + "/switch?signed=private-query",
        })
    ).id;
    db = new Database(process.env.KUMA_E2E_DB_PATH, { fileMustExist: true });
});
test.afterAll(async () => {
    if (owner?.connected && monitorID) {
        await call(owner, "projectControlMonitor", { projectID, id: monitorID, action: "pause" });
    }
    for (const socket of sockets) {
        socket.disconnect();
    }
    db?.close();
});

test("direct requests cannot cross projects, escalate roles or call legacy administrator endpoints", async ({
    baseURL,
}) => {
    const viewer = people.viewer.socket;
    const unrelated = await viewer.timeout(10000).emitWithAck("projectSnapshot", { projectID: otherID });
    expect(unrelated.ok).toBe(false);
    for (const event of [
        "getSettings",
        "getMonitorList",
        "getNotificationList",
        "getAPIKeyList",
        "getDockerHostList",
        "setSettings",
        "add",
    ]) {
        const denied = await viewer.timeout(10000).emitWithAck(event, {});
        expect(denied.ok, event).toBe(false);
        expect(denied.msg).toBe("projectAccessDenied");
    }
    for (const event of ["projectAISettings", "projectMembers", "projectDeliverySave"]) {
        expect((await viewer.timeout(10000).emitWithAck(event, { projectID })).ok, event).toBe(false);
    }
    expect((await people.operator.socket.timeout(10000).emitWithAck("projectAISettings", { projectID })).ok).toBe(
        false
    );
    const metrics = await fetch(baseURL + "/metrics", {
        headers: { Authorization: "Basic " + Buffer.from(people.viewer.username + ":" + password).toString("base64") },
    });
    expect(metrics.status).toBe(401);
    const row = db.prepare("SELECT active, project_only FROM user WHERE username=?").get(people.viewer.username);
    expect(row).toEqual({ active: 0, project_only: 1 });
});

test("restricted monitoring blocks unapproved private targets and private redirects", async () => {
    for (const [targetProject, url] of [
        [otherID, peer.http + "/"],
        [projectID, peer.http + "/redirect-private"],
    ]) {
        const id = (
            await call(owner, "projectSaveMonitor", {
                projectID: targetProject,
                name: "Stage3 blocked synthetic target",
                type: "http",
                interval: 20,
                maxretries: 0,
                url,
            })
        ).id;
        try {
            await expect
                .poll(
                    () =>
                        db.prepare("SELECT msg FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(id)
                            ?.msg,
                    { timeout: 20000 }
                )
                .toContain("PROJECT_TARGET_BLOCKED");
            expect(
                db.prepare("SELECT status FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(id).status
            ).toBe(0);
        } finally {
            await call(owner, "projectControlMonitor", { projectID: targetProject, id, action: "pause" });
        }
    }
    await expect
        .poll(
            () =>
                db.prepare("SELECT status FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(monitorID)
                    ?.status,
            { timeout: 20000 }
        )
        .toBe(1);
});

test("viewer interface shows only its project, reports and escaped observations", async ({ page }, testInfo) => {
    await open(page, people.viewer);
    await expect(page.getByLabel(tr("projectChoose")).locator("option")).toHaveCount(1);
    await expect(page.getByRole("button", { name: tr("projectAddCheck"), exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: tr("projectTab_members"), exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("project-check-details")).not.toContainText("private-query");
    await page.getByRole("button", { name: tr("projectTab_reports"), exact: true }).click();
    await page.getByRole("button", { name: tr("projectBuildReport"), exact: true }).click();
    await expect(page.getByTestId("project-report").locator("dl")).toBeVisible();
    await expect(page.getByTestId("project-report")).toContainText(tr("projectReportUnknown"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("project-viewer-mobile.png"), fullPage: true });
    const linked = (await call(people.viewer.socket, "projectSnapshot", { projectID })).monitors.at(-1);
    await page.goto(`/projects/${projectID}?check=${linked.id}`);
    await expect(
        page.getByTestId("project-check-details").getByRole("heading", { name: linked.name, exact: true })
    ).toBeVisible();
    await page.goto("/projects/" + otherID);
    await expect(page.getByTestId("projects-page")).toContainText(tr("projectAccessDenied"));
    await expect(page.getByTestId("project-check-details")).toHaveCount(0);
});

test("operator can add and control checks while channel credentials and AI settings stay closed", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, people.operator);
    await expect(page.getByRole("button", { name: tr("projectAddCheck"), exact: true })).toHaveCSS("font-size", "15px");
    await page.getByRole("button", { name: tr("projectAddCheck"), exact: true }).click();
    const editor = page.getByTestId("project-monitor-editor");
    await editor.getByLabel("Friendly Name", { exact: true }).fill("Stage3 operator check");
    await editor.getByLabel("URL", { exact: true }).fill(peer.http + "/health.json");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(
        page.getByTestId("project-check-details").getByRole("heading", { name: "Stage3 operator check", exact: true })
    ).toBeVisible();
    await page.getByTestId("project-check-details").getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
        page.getByTestId("project-check-details").getByRole("button", { name: "Resume", exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: tr("projectTab_channels"), exact: true }).click();
    await expect(page.getByRole("button", { name: "Connect email", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: tr("projectTab_ai"), exact: true }).click();
    await expect(page.getByLabel(tr("projectAIMode"))).toHaveCount(0);
});

test("project administrator configures encrypted SMTP and tests only that project's selected checks", async ({
    page,
}) => {
    await open(page, people.admin);
    await page.getByRole("button", { name: tr("projectTab_channels"), exact: true }).click();
    await page.getByRole("button", { name: "Connect email", exact: true }).click();
    const wizard = page.getByTestId("alert-wizard");
    await wizard.getByLabel("Friendly Name", { exact: true }).fill("Stage3 protected mail");
    await wizard.getByLabel("Mail server", { exact: true }).fill("localhost");
    await wizard.getByLabel("Port", { exact: true }).fill(String(peer.smtpPort));
    await wizard.getByLabel("Username", { exact: true }).fill("synthetic-project-mail");
    await wizard.getByLabel("Password", { exact: true }).fill("synthetic-smtp-private");
    await wizard.getByLabel("Sender address", { exact: true }).fill("project-from@example.test");
    await wizard.getByLabel("Recipient address", { exact: true }).fill("project-to@example.test");
    await wizard.getByRole("button", { name: "Choose services", exact: true }).click();
    await wizard.getByRole("checkbox", { name: "Stage3 controlled website", exact: true }).check();
    await wizard.getByRole("button", { name: "Save channel and selection", exact: true }).click();
    await expect(wizard.getByText("Settings saved. No test has been sent.", { exact: true })).toBeVisible({
        timeout: 20000,
    });
    const channel = db.prepare("SELECT id,config FROM notification WHERE name=?").get("Stage3 protected mail");
    expect(channel.config).not.toContain("synthetic-smtp-private");
    expect(channel.config).not.toContain("project-to@example.test");
    await wizard.getByRole("button", { name: "Send test message", exact: true }).click();
    await expect(wizard.getByTestId("notification-test-state")).toContainText("Accepted by sending service", {
        timeout: 20000,
    });
    const overview = await call(people.viewer.socket, "projectDeliveryGet", { projectID });
    expect(JSON.stringify(overview)).not.toContain("project-to@example.test");
    expect(JSON.stringify(overview)).not.toContain("synthetic-project-mail");
    expect(db.prepare("SELECT monitor_id FROM monitor_notification WHERE notification_id=?").all(channel.id)).toEqual([
        { monitor_id: monitorID },
    ]);
});

test("administrator API setup, explicit probe and consented diagnosis complete end to end without sharing secrets", async ({
    page,
}, testInfo) => {
    // Keep the consented facts stable while this test inspects the exact preview.
    // Changing facts are covered separately by the backend rejection test.
    await call(owner, "projectControlMonitor", { projectID, id: monitorID, action: "pause" });
    await open(page, people.admin);
    await page.getByRole("button", { name: tr("projectTab_ai"), exact: true }).click();
    const panel = page.getByTestId("project-ai");
    const initial = requests().length;
    await panel.getByLabel(tr("projectAIMode")).selectOption("api");
    await panel.getByLabel(tr("projectAIKey")).fill("synthetic-stage3-api-secret");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText(tr("projectAISavedNoCall"), { exact: true })).toBeVisible();
    expect(requests().length).toBe(initial);
    const row = db.prepare("SELECT secret_cipher FROM project_ai WHERE project_id=?").get(projectID);
    expect(row.secret_cipher).not.toContain("synthetic-stage3-api-secret");
    await panel.getByRole("button", { name: tr("projectAILoadModels"), exact: true }).click();
    await panel.getByLabel(tr("projectAIModel"), { exact: true }).selectOption("gpt-synthetic-api");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await panel.getByRole("button", { name: tr("projectAIProbe"), exact: true }).click();
    await expect(panel.locator(".ws-project-badge")).toHaveText(tr("projectAIState_verified"), { timeout: 20000 });
    expect(requests().length).toBe(initial + 1);
    await panel.getByRole("button", { name: tr("projectAIPreview"), exact: true }).click();
    await panel.getByText(tr("projectAIExactData"), { exact: true }).click();
    await expect(panel.locator("pre")).not.toContainText("private-query");
    await expect(panel.locator("pre")).not.toContainText("Stage3 controlled website");
    await panel.getByRole("button", { name: tr("projectAISendDiagnosis"), exact: true }).click();
    await expect.poll(() => requests().length).toBe(initial + 2);
    await expect(panel.locator(".ws-project-ai-result")).toHaveCount(2, { timeout: 20000 });
    await expect(panel.locator(".ws-project-ai-result").first()).toContainText("Учебный ответ", { timeout: 20000 });
    await expect(panel).not.toContainText("synthetic-stage3-api-secret");
    const payload = requests().at(-1).payload;
    expect(JSON.stringify(payload)).not.toContain("private-query");
    expect(payload.store).toBe(false);
    expect(payload.tools).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("project-ai-completed.png"), fullPage: true });
});

test("subscription login uses issued identity, validates callback and needs its own completed probe", async ({
    page,
    context,
}) => {
    await open(page, people.admin);
    await page.getByRole("button", { name: tr("projectTab_ai"), exact: true }).click();
    const panel = page.getByTestId("project-ai");
    await panel.getByLabel(tr("projectAIMode")).selectOption("subscription");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await panel.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    const link = panel.getByRole("link", { name: tr("projectAIOpenSignIn"), exact: true });
    await expect(link).toBeVisible();
    const auth = new URL(await link.getAttribute("href"));
    expect(auth.hostname).toBe("127.0.0.1"); // Test-only fake authorization peer; never a real account.
    const callback = new URL(auth.searchParams.get("redirect_uri"));
    callback.search = "?state=wrong&code=wrong";
    expect((await fetch(callback)).status).toBe(400);
    const popup = await context.newPage();
    await popup.goto(auth.href);
    await expect(popup.locator("body")).toContainText("Подключение сохранено");
    await popup.close();
    await expect(panel.getByText("Connected account: fixture@example.test", { exact: true })).toBeVisible({
        timeout: 15000,
    });
    await expect(panel.locator(".ws-project-badge")).toHaveText(tr("projectAIState_saved"));
    await panel.getByRole("button", { name: tr("projectAILoadModels"), exact: true }).click();
    await panel.getByLabel(tr("projectAIModel"), { exact: true }).selectOption("gpt-synthetic-plan");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await panel.getByRole("button", { name: tr("projectAIProbe"), exact: true }).click();
    await expect(panel.locator(".ws-project-badge")).toHaveText(tr("projectAIState_verified"), { timeout: 20000 });
    expect(Object.hasOwn(requests().at(-1).payload, "max_output_tokens")).toBe(false);
});

test("downloaded standalone helper securely transfers a synthetic subscription to the same application", async ({
    request,
    context,
}, testInfo) => {
    const current = await call(people.admin.socket, "projectAISettings", { projectID });
    const pairing = (
        await call(people.admin.socket, "projectAIPairing", { projectID, revision: current.settings.revision })
    ).pairing;
    const helper = await request.get("/api/project-ai/helper");
    expect(helper.ok()).toBe(true);
    const filename = testInfo.outputPath("uptime-kuma-ai-sign-in.cjs");
    fs.writeFileSync(filename, await helper.text());
    const pairingFile = testInfo.outputPath("uptime-kuma-pairing.json");
    fs.writeFileSync(pairingFile, JSON.stringify(pairing), { mode: 0o600 });
    const child = spawn(
        process.execPath,
        ["--require", path.resolve("test/e2e/helpers/install-helper-fixture.cjs"), filename, pairingFile],
        { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let popup;
    try {
        const auth = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Helper sign-in did not start")), 10000);
            let output = "";
            child.stdout.on("data", (chunk) => {
                output += chunk;
                const match = output.match(/https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?[^\s]+/);
                if (match) {
                    clearTimeout(timeout);
                    resolve(new URL(match[0]));
                }
            });
            child.once("error", () => {
                clearTimeout(timeout);
                reject(new Error("Helper did not start"));
            });
        });
        const fake = JSON.parse(fs.readFileSync(path.join(folder, "ai-fixture.json"), "utf8"));
        const local = new URL(auth.pathname + auth.search, fake.url);
        popup = await context.newPage();
        await popup.goto(local.href);
        await expect(popup.locator("body")).toContainText("Подключение передано вашему серверу");
        expect(await exited).toBe(0);
        const updated = await call(people.admin.socket, "projectAISettings", { projectID });
        expect(updated.settings.state).toBe("saved");
        expect(updated.settings.hasSecret).toBe(true);
        expect(
            (
                await request.post("/api/project-ai/import/" + pairing.pairingID, {
                    headers: { Authorization: "Bearer " + pairing.token },
                    data: {},
                })
            ).status()
        ).toBe(403);
    } finally {
        await popup?.close();
        if (child.exitCode === null) {
            child.kill();
        }
    }
});

test("role changes close already-open private channel and check editors", async ({ page, browser }) => {
    await open(page, people.admin);
    await page.getByRole("button", { name: tr("projectTab_channels"), exact: true }).click();
    await page.getByTestId("project-channels").getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("alert-wizard").getByLabel("Recipient address", { exact: true })).toHaveValue(
        "project-to@example.test"
    );
    const adminID = db.prepare("SELECT id FROM user WHERE username=?").get(people.admin.username).id;
    let snapshot = await call(owner, "projectSnapshot", { projectID });
    await call(owner, "projectChangeMember", {
        projectID,
        userID: adminID,
        role: "operator",
        revision: snapshot.project.revision,
    });
    await expect(page.getByTestId("alert-wizard")).toHaveCount(0, { timeout: 15000 });
    snapshot = await call(owner, "projectSnapshot", { projectID });
    await call(owner, "projectChangeMember", {
        projectID,
        userID: adminID,
        role: "admin",
        revision: snapshot.project.revision,
    });
    const context = await browser.newContext();
    const operatorPage = await context.newPage();
    await open(operatorPage, people.operator);
    await operatorPage.getByRole("button", { name: tr("projectAddCheck"), exact: true }).click();
    await expect(operatorPage.getByTestId("project-monitor-editor")).toBeVisible();
    const operatorID = db.prepare("SELECT id FROM user WHERE username=?").get(people.operator.username).id;
    snapshot = await call(owner, "projectSnapshot", { projectID });
    await call(owner, "projectChangeMember", {
        projectID,
        userID: operatorID,
        role: "viewer",
        revision: snapshot.project.revision,
    });
    await expect(operatorPage.getByTestId("project-monitor-editor")).toHaveCount(0, { timeout: 15000 });
    snapshot = await call(owner, "projectSnapshot", { projectID });
    await call(owner, "projectChangeMember", {
        projectID,
        userID: operatorID,
        role: "operator",
        revision: snapshot.project.revision,
    });
    await context.close();
});

test("an invited participant changes only their own password and can verify two-step sign-in", async ({
    page,
    baseURL,
}) => {
    await open(page, people.operator);
    await page.locator(".workspace-account").click();
    await page.getByRole("link", { name: tr("projectMyAccount"), exact: true }).click();
    const panel = page.getByTestId("project-account");
    const changed = "Changed-synthetic-password-1234";
    const passwordForm = panel.getByTestId("account-password-form");
    await passwordForm.getByLabel("Current Password", { exact: true }).fill(password);
    await passwordForm.getByLabel("New Password", { exact: true }).fill(changed);
    await passwordForm.getByLabel("Repeat New Password", { exact: true }).fill(changed);
    await panel.getByRole("button", { name: "Change Password", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText(tr("successAuthChangePassword"));
    await page.reload();
    await expect(panel).toBeVisible();
    const socket = await connect(baseURL);
    await call(socket, "login", { username: people.operator.username, password: changed, token: "" });
    const prepared = await call(socket, "prepare2FA", changed);
    expect((await socket.timeout(10000).emitWithAck("save2FA", changed)).ok).toBe(false);
    const secret = new URL(prepared.uri).searchParams.get("secret");
    const code = notp.totp.gen(base32.decode(secret));
    expect((await call(socket, "verifyToken", code, changed)).valid).toBe(true);
    await call(socket, "save2FA", changed);
    expect((await call(socket, "twoFAStatus")).status).toBe(true);
    const fresh = await connect(baseURL);
    expect(
        (
            await fresh
                .timeout(10000)
                .emitWithAck("login", { username: people.operator.username, password: changed, token: "" })
        ).tokenRequired
    ).toBe(true);
    await call(fresh, "login", { username: people.operator.username, password: changed, token: code });
    await call(fresh, "disable2FA", changed);
});

test("owner creates an empty project, changes its internal target policy and manages invitations through the interface", async ({
    page,
}) => {
    await open(page);
    await page.getByRole("button", { name: tr("projectCreate"), exact: true }).click();
    const form = page.getByTestId("project-create-form");
    await form.getByLabel(tr("projectName"), { exact: true }).fill("Stage3 created in interface");
    await form.getByLabel(tr("projectTimezone"), { exact: true }).fill("Europe/Moscow");
    await form.getByLabel(tr("projectAllowedIPs")).fill("127.0.0.1");
    await form.getByRole("button", { name: tr("projectCreate"), exact: true }).click();
    await expect(form).toHaveCount(0);
    const newProject = db.prepare("SELECT id FROM project WHERE name=?").get("Stage3 created in interface");
    await expect(page).toHaveURL(new RegExp("/projects/" + newProject.id + "$"));
    await expect(page.getByText(tr("projectNoChecks"), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: tr("projectSettings"), exact: true }).click();
    const settings = page.getByTestId("project-settings-form");
    await settings.getByLabel(tr("projectAllowedIPs")).fill("127.0.0.2");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings).toHaveCount(0);
    expect(
        JSON.parse(db.prepare("SELECT allowed_ips_json FROM project WHERE id=?").get(newProject.id).allowed_ips_json)
    ).toEqual(["127.0.0.2"]);
    await page.getByRole("button", { name: tr("projectTab_members"), exact: true }).click();
    await page.getByRole("button", { name: tr("projectMakeInvite"), exact: true }).click();
    const link = page.getByLabel(tr("projectInviteLink"), { exact: true });
    await expect(link).toBeVisible();
    const token = new URL(await link.inputValue()).hash.slice(1);
    expect((await call(owner, "projectInviteInfo", { token })).role).toBe("viewer");
    await page.getByRole("button", { name: tr("projectRevokeInvite"), exact: true }).click();
    await expect(page.getByRole("button", { name: tr("projectRevokeInvite"), exact: true })).toHaveCount(0);
    expect((await owner.timeout(10000).emitWithAck("projectInviteInfo", { token })).ok).toBe(false);
    await page.getByRole("button", { name: tr("projectTab_audit"), exact: true }).click();
    await expect(page.locator(".ws-project-audit-list")).toContainText(tr("projectAudit_projectCreated"));
});

test("revoked membership clears a live page and one-use invitations work through the public form", async ({
    page,
    browser,
    baseURL,
}) => {
    await open(page, people.viewer);
    const snapshot = await call(owner, "projectSnapshot", { projectID });
    const person = db.prepare("SELECT id FROM user WHERE username=?").get(people.viewer.username);
    await call(owner, "projectChangeMember", {
        projectID,
        userID: person.id,
        role: null,
        revision: snapshot.project.revision,
    });
    await expect(page.getByTestId("project-check-details")).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("projects-page")).toContainText(tr("projectAccessDenied"));
    const invitation = await call(owner, "projectCreateInvite", { projectID, role: "viewer" });
    const guest = await browser.newContext();
    const join = await guest.newPage();
    await join.goto(baseURL + "/join-project#" + invitation.token);
    await expect(join.getByRole("heading", { name: "Stage3 isolated project", exact: true })).toBeVisible();
    await join.getByLabel("Username", { exact: true }).fill("stage3-ui-invite");
    await join.getByLabel("Password", { exact: true }).fill(password);
    await join.getByRole("button", { name: tr("projectJoinAction"), exact: true }).click();
    await expect(join).toHaveURL(new RegExp("/projects/" + projectID + "$"));
    await expect(join.getByLabel(tr("projectChoose")).locator("option")).toHaveCount(1);
    const replay = await connect(baseURL);
    expect((await replay.timeout(10000).emitWithAck("projectInviteInfo", { token: invitation.token })).ok).toBe(false);
    await guest.close();
});
