import { e2eOwnerPassword, getSetupCode } from "../util-test";
import { test, expect } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
const en = JSON.parse(fs.readFileSync("src/lang/en.json", "utf8"));
const tr = (key) => en[key];
const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
const sockets = [];
const workspaces = {};
let owner;
let ownerToken;
let viewer;
let administrator;
let db;
test.describe.configure({ mode: "serial" });
test.beforeEach(() => test.setTimeout(180000));

/**
 * @param {string} baseURL Owned app
 * @returns {Promise<object>} Connected identity
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
 * @param {object} socket Actor
 * @param {string} event Closed API
 * @param {...any} args Parameters
 * @returns {Promise<object>} Reply
 */
async function call(socket, event, ...args) {
    const result = await socket.timeout(60000).emitWithAck(event, ...args);
    expect(result.ok, event + ": " + result.msg).toBe(true);
    return result;
}
/**
 * @param {object} page Owned browser
 * @param {object} value Scope
 * @param {string} token Human token
 * @returns {Promise<object>} Recovery panel
 */
async function open(page, value, token = ownerToken) {
    await page.addInitScript((token) => {
        localStorage.setItem("token", token);
        localStorage.setItem("remember", "1");
        localStorage.setItem("locale", "en");
    }, token);
    await page.goto("/projects/" + value.projectID);
    await page
        .locator(".ws-project-tabs")
        .getByRole("button", { name: tr("projectTab_recovery"), exact: true })
        .click();
    const panel = page.getByTestId("project-recovery");
    await expect(panel.getByLabel(tr("projectRecoveryApplication"))).toBeVisible();
    return panel;
}
/**
 * @param {object} panel Recovery panel
 * @param {object} value Owned application
 * @param {boolean} expirePreview Verify a changed observation requires a new explicit review
 * @returns {Promise<void>} Reviewable model-backed plan
 */
async function propose(panel, value, expirePreview = false) {
    // Align this exact-consent test just after a real regular observation, leaving a full interval for review.
    const previous = db
        .prepare("SELECT id FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1")
        .get(value.monitorID)?.id;
    await expect
        .poll(
            () =>
                db.prepare("SELECT id FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(value.monitorID)
                    ?.id,
            { timeout: 30000 }
        )
        .not.toBe(previous);
    await panel.getByRole("button", { name: tr("projectRecoveryReviewData"), exact: true }).click();
    await expect(panel.getByTestId("recovery-evidence")).toBeVisible();
    await panel.getByTestId("recovery-evidence").getByText(tr("projectRecoveryShowData"), { exact: true }).click();
    await expect(panel.getByTestId("recovery-evidence").locator("pre")).toBeVisible();
    expect(await panel.getByTestId("recovery-evidence").textContent()).not.toContain("synthetic-application-secret");
    if (expirePreview) {
        const reviewedID = db.prepare("SELECT id FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(value.monitorID).id;
        await expect.poll(
            () => db.prepare("SELECT id FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(value.monitorID).id,
            { timeout: 30000 }
        ).not.toBe(reviewedID);
        await panel.getByRole("button", { name: tr("projectRecoveryAskAI"), exact: true }).click();
        await expect(panel).toContainText(tr("projectAIEvidenceChanged"));
        await expect(panel.getByTestId("recovery-evidence")).toHaveCount(0);
        expect(db.prepare("SELECT COUNT(*) AS n FROM project_ai_job WHERE project_id=? AND kind='recovery'").get(value.projectID).n).toBe(0);
        await panel.getByRole("button", { name: tr("projectRecoveryReviewData"), exact: true }).click();
        await expect(panel.getByTestId("recovery-evidence")).toBeVisible();
    }
    await panel.getByRole("button", { name: tr("projectRecoveryAskAI"), exact: true }).click();
    await expect(panel.getByTestId("recovery-proposal")).toContainText("Учебное предложение", { timeout: 30000 });
    expect(fs.readFileSync(value.file, "utf8")).toBe(value.before);
    await panel.getByRole("button", { name: tr("projectRecoveryMakePlan"), exact: true }).click();
    await expect(panel.getByRole("button", { name: tr("projectRecoveryReviewApproval"), exact: true })).toBeVisible();
}
/**
 * @param {object} panel Recovery panel
 * @param {string} operation Visible owner decision
 * @returns {Promise<object>} Confirmation form
 */
async function confirmation(panel, operation) {
    await panel.getByRole("button", { name: tr(operation), exact: true }).click();
    const form = panel.getByTestId("recovery-confirmation");
    await expect(form).toBeVisible();
    await form.getByRole("checkbox").check();
    await form.getByLabel("Current Password", { exact: true }).fill(e2eOwnerPassword);
    return form;
}

test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(90000);
    owner = await connect(baseURL);
    if (await owner.timeout(10000).emitWithAck("needSetup")) {
        await call(owner, "setup", { username: "admin", password: e2eOwnerPassword, code: getSetupCode() });
    }
    ownerToken = (await call(owner, "login", { username: "admin", password: e2eOwnerPassword, token: "" })).token;
    const fixture = JSON.parse(fs.readFileSync(path.join(folder, "recovery-fixture.json"), "utf8"));
    const targets = [];
    for (const name of ["first", "second"]) {
        const app = fixture.apps[name];
        const projectID = (
            await call(owner, "projectCreate", {
                name: "Recovery " + name,
                timezone: "Europe/Moscow",
                allowedIPs: ["127.0.0.1"],
            })
        ).id;
        const monitorID = (
            await call(owner, "projectSaveMonitor", {
                projectID,
                name: "Owned recovery application " + name,
                type: "http",
                url: app.url,
                interval: 20,
                maxretries: 0,
            })
        ).id;
        const current = (await call(owner, "projectAISettings", { projectID })).settings;
        let saved = (
            await call(owner, "projectAISave", {
                ...current,
                projectID,
                mode: "api",
                apiKey: "synthetic-recovery-api-key",
                dailyLimit: 10,
            })
        ).settings;
        await call(owner, "projectAIModels", { projectID, revision: saved.revision });
        saved = (await call(owner, "projectAISave", { ...saved, projectID, model: "gpt-synthetic-api" })).settings;
        await call(owner, "projectAIEnqueue", { projectID, revision: saved.revision, kind: "probe" });
        await expect
            .poll(async () => (await call(owner, "projectAISettings", { projectID })).settings.state, {
                timeout: 20000,
            })
            .toBe("verified");
        const target = {
            id: "owned-" + name,
            projectID,
            monitorID,
            title: "Owned application " + name,
            root: app.root,
            file: app.file,
            baseline: app.baseline,
            baselineSha256: app.baselineSha256,
            checkURL: app.url,
            reload: { kind: "live" },
            verifySeconds: 60,
        };
        targets.push(target);
        workspaces[name] = { ...app, projectID, monitorID, targetID: target.id };
    }
    for (const role of ["viewer", "admin"]) {
        const invite = await call(owner, "projectCreateInvite", { projectID: workspaces.first.projectID, role });
        const socket = await connect(baseURL);
        const username = "recovery-" + role;
        await call(socket, "projectAcceptInvite", {
            token: invite.token,
            username,
            password: "synthetic-recovery-password",
        });
        const logged = await call(socket, "login", { username, password: "synthetic-recovery-password", token: "" });
        if (role === "viewer") {
            viewer = { socket, ...logged };
        } else {
            administrator = { socket, ...logged };
        }
    }
    fs.writeFileSync(path.join(folder, "recovery-manifest.json"), JSON.stringify({ version: 1, targets }), {
        mode: 0o600,
    });
    await expect
        .poll(
            async () =>
                (await call(owner, "projectRecoveryGet", { projectID: workspaces.first.projectID })).executorReady,
            { timeout: 20000 }
        )
        .toBe(true);
    db = new Database(process.env.KUMA_E2E_DB_PATH, { fileMustExist: true });
});
test.afterAll(async () => {
    for (const value of Object.values(workspaces)) {
        if (owner?.connected) {
            await call(owner, "projectControlMonitor", {
                projectID: value.projectID,
                id: value.monitorID,
                action: "pause",
            });
        }
    }
    for (const socket of sockets) {
        socket.disconnect();
    }
    db?.close();
});

test("viewer sees only scoped recovery facts and cannot approve or substitute a different project", async ({
    page,
}) => {
    const value = workspaces.first;
    const panel = await open(page, value, viewer.token);
    await expect(panel).toContainText(tr("projectRecoveryOwnerOnly"));
    await expect(panel.getByRole("button", { name: tr("projectRecoveryReviewData"), exact: true })).toHaveCount(0);
    await expect(panel.getByLabel("Current Password", { exact: true })).toHaveCount(0);
    const denied = await viewer.socket.timeout(12000).emitWithAck("projectRecoveryApprove", {
        projectID: value.projectID,
        id: 1,
        confirm: true,
        password: "irrelevant",
        command: "must-never-run",
    });
    expect(denied.ok).toBe(false);
    expect(
        (
            await viewer.socket
                .timeout(12000)
                .emitWithAck("projectRecoveryGet", { projectID: workspaces.second.projectID })
        ).ok
    ).toBe(false);
    expect(await panel.textContent()).not.toContain(value.file);
    expect(fs.readFileSync(value.file, "utf8")).toBe(value.before);
});

test("owner reviews AI facts, approves once, receives two actual HTTP successes and can restore the prior configuration", async ({
    page,
}, testInfo) => {
    const value = workspaces.first;
    const panel = await open(page, value);
    await propose(panel, value, true);
    const plan = (await call(owner, "projectRecoveryGet", { projectID: value.projectID })).jobs[0];
    expect(
        (
            await administrator.socket.timeout(12000).emitWithAck("projectRecoveryApprove", {
                ...plan,
                projectID: value.projectID,
                password: "synthetic-recovery-password",
                confirm: true,
            })
        ).ok
    ).toBe(false);
    const form = await confirmation(panel, "projectRecoveryReviewApproval");
    await expect(form).toContainText("Owned application first");
    await expect(form).toContainText(tr("projectRecoveryReplaceOne"));
    await expect(form).toContainText(tr("projectRecoveryRollbackOnFailure"));
    await form.getByLabel("Current Password", { exact: true }).fill("wrong-password");
    await form.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
    await expect(form).toContainText(tr("projectRecoveryPassword"));
    expect(fs.readFileSync(value.file, "utf8")).toBe(value.before);
    await form.getByLabel("Current Password", { exact: true }).fill(e2eOwnerPassword);
    await form.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
    await expect.poll(() => fs.readFileSync(value.file, "utf8"), { timeout: 30000 }).toBe(value.after);
    await expect(panel).toContainText(tr("projectRecoveryStatus_verifying"), { timeout: 10000 });
    const firstSuccess = () =>
        db.prepare("SELECT COUNT(*) AS n FROM heartbeat WHERE monitor_id=? AND status=1").get(value.monitorID).n;
    await expect.poll(firstSuccess, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    expect((await call(owner, "projectRecoveryGet", { projectID: value.projectID })).jobs[0].status).toBe("verifying");
    await expect(panel).toContainText(tr("projectRecoveryStatus_succeeded"), { timeout: 70000 });
    const completed = (await call(owner, "projectRecoveryGet", { projectID: value.projectID })).jobs[0];
    expect(completed.verification.observations).toHaveLength(2);
    expect(
        db.prepare("SELECT snapshot_cipher FROM project_recovery WHERE id=?").get(completed.id).snapshot_cipher
    ).not.toContain("synthetic-application-secret");
    for (const width of [360, 390, 768, 1366, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath("approved-recovery-verified.png"), fullPage: true });
    const returned = await confirmation(panel, "projectRecoveryReturn");
    await returned.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
    await expect(panel).toContainText(tr("projectRecoveryStatus_rolled_back"), { timeout: 45000 });
    expect(fs.readFileSync(value.file, "utf8")).toBe(value.before);
    await expect(panel).toContainText(tr("projectRecoveryRollbackUnhealthy"));
});

test("a real verification failure automatically restores exact bytes and presents the blocked result honestly", async ({
    page,
}, testInfo) => {
    const value = workspaces.second;
    fs.writeFileSync(path.join(folder, "recovery-control.json"), JSON.stringify({ first: false, second: true }));
    const panel = await open(page, value);
    await propose(panel, value);
    const form = await confirmation(panel, "projectRecoveryReviewApproval");
    await form.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
    await expect.poll(() => fs.readFileSync(value.file, "utf8"), { timeout: 30000 }).toBe(value.after);
    await expect(panel).toContainText(tr("projectRecoveryStatus_rolled_back"), { timeout: 115000 });
    expect(fs.readFileSync(value.file, "utf8")).toBe(value.before);
    await expect(panel).toContainText(tr("projectRecoveryBlocked"));
    await expect(panel).not.toContainText(tr("projectRecoveryStatus_succeeded"));
    const result = (await call(owner, "projectRecoveryGet", { projectID: value.projectID })).jobs[0];
    expect(result.verification).toBeNull();
    expect(result.rollbackVerification.healthy).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("automatic-rollback-mobile.png"), fullPage: true });
});
