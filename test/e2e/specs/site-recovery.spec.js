import { e2eOwnerPassword, getSetupCode } from "../util-test";
import { test, expect } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
const en = JSON.parse(fs.readFileSync("src/lang/en.json"));
const tr = (key) => en[key];

test("fixed site recovery: owner confirmation, actual HTTP checks, retained copy and honest rollback", async ({
    page,
    baseURL,
}) => {
    test.setTimeout(240000);
    const socket = io(baseURL, { transports: ["websocket"], reconnection: false, autoConnect: false });
    await new Promise((resolve, reject) => {
        socket.once("info", resolve);
        socket.once("connect_error", reject);
        socket.connect();
    });
    const call = async (event, request) => {
        for (let attempt = 0; attempt < 8; attempt++) {
            const reply = await socket.timeout(30000).emitWithAck(event, request);
            if (reply.msg === "projectBusy" && attempt < 7) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                continue;
            }
            expect(reply.ok, `${event}: ${reply.msg}`).toBe(true);
            return reply;
        }
    };
    let projectID;
    let monitorID;
    try {
        if (await socket.timeout(10000).emitWithAck("needSetup")) {
            const setup = await socket.timeout(10000).emitWithAck("setup", { username: "admin", password: e2eOwnerPassword, code: getSetupCode() });
            expect(setup.ok).toBe(true);
        }
        const login = await call("login", { username: "admin", password: e2eOwnerPassword, token: "" });
        const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
        const app = JSON.parse(fs.readFileSync(path.join(folder, "recovery-fixture.json"))).apps.first;
        projectID = (await call("projectCreate", { name: "Fixed site recovery", allowedIPs: ["127.0.0.1"] })).id;
        monitorID = (
            await call("projectSaveMonitor", {
                projectID,
                name: "Owned HTTP recovery fixture",
                type: "http",
                url: app.url,
                interval: 20,
                maxretries: 0,
            })
        ).id;
        const settings = (await call("projectAISettings", { projectID })).settings;
        let saved = (
            await call("projectAISave", {
                ...settings,
                projectID,
                mode: "api",
                apiKey: "synthetic-site-api-key",
                dailyLimit: 10,
            })
        ).settings;
        await call("projectAIModels", { projectID, revision: saved.revision });
        saved = (await call("projectAISave", { ...saved, projectID, model: "gpt-synthetic-api" })).settings;
        await call("projectAIEnqueue", { projectID, revision: saved.revision, kind: "probe" });
        await expect
            .poll(async () => (await call("projectAISettings", { projectID })).settings.state, { timeout: 20000 })
            .toBe("verified");
        fs.writeFileSync(
            path.join(folder, "site-recovery.json"),
            JSON.stringify({
                synthetic: true,
                file: app.file,
                baseline: app.baseline,
                targets: [
                    {
                        id: "site-fixture",
                        projectID,
                        monitorID,
                        ownerID: 1,
                        title: "Owned site fixture",
                        action: "restart_service",
                        fingerprint: "a".repeat(64),
                        verifySeconds: 65,
                        checkURL: app.url,
                    },
                ],
            })
        );
        await expect
            .poll(async () => (await call("projectSiteRecoveryGet", { projectID })).executorReady, { timeout: 15000 })
            .toBe(true);
        await page.addInitScript((token) => {
            localStorage.setItem("token", token);
            localStorage.setItem("remember", "1");
            localStorage.setItem("locale", "en");
        }, login.token);
        await page.goto("/projects/" + projectID);
        await page
            .locator(".ws-project-tabs")
            .getByRole("button", { name: tr("projectTab_recovery"), exact: true })
            .click();
        const panel = page.getByTestId("project-site-recovery");
        await expect(panel.getByLabel(tr("projectRecoveryApplication"))).toHaveValue("site-fixture");
        await expect(panel).toContainText(tr("projectSiteRecoveryRisk_restart_service"));
        await panel.getByRole("button", { name: tr("projectRecoveryReviewData"), exact: true }).click();
        await expect(panel.getByTestId("recovery-evidence")).toBeVisible();
        await panel.getByRole("button", { name: tr("projectRecoveryAskAI"), exact: true }).click();
        await expect(panel.getByRole("button", { name: tr("projectRecoveryMakePlan"), exact: true })).toBeVisible({
            timeout: 20000,
        });
        expect(fs.readFileSync(app.file, "utf8")).toBe(app.before);
        await panel.getByRole("button", { name: tr("projectRecoveryMakePlan"), exact: true }).click();
        await panel.getByRole("button", { name: tr("projectRecoveryReviewApproval"), exact: true }).click();
        const form = panel.getByTestId("recovery-confirmation");
        await expect(form).toContainText(tr("projectSiteRecoveryRisk_restart_service"));
        await expect(form.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true })).toBeDisabled();
        expect(fs.readFileSync(app.file, "utf8")).toBe(app.before);
        await form.getByRole("checkbox").check();
        await form.getByLabel("Current Password", { exact: true }).fill(e2eOwnerPassword);
        await form.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
        await expect
            .poll(async () => (await call("projectSiteRecoveryGet", { projectID })).jobs[0]?.status, { timeout: 70000 })
            .toBe("succeeded");
        await expect(panel).toContainText(tr("projectSiteRecoveryBackupRetained"));
        expect(fs.readFileSync(app.file, "utf8")).toBe(app.after);
        const complete = (await call("projectSiteRecoveryGet", { projectID })).jobs[0];
        expect(complete.verification.observations).toHaveLength(2);
        expect(complete.backup.expiresAt).toBe(null);
        await page.screenshot({
            path: path.join(process.env.KUMA_E2E_DATA_DIR, "site-recovery-success.png"),
            fullPage: true,
        });
        await panel.getByRole("button", { name: tr("projectRecoveryReturn"), exact: true }).click();
        await form.getByRole("checkbox").check();
        await form.getByLabel("Current Password", { exact: true }).fill(e2eOwnerPassword);
        await form.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
        await expect
            .poll(async () => (await call("projectSiteRecoveryGet", { projectID })).jobs[0]?.status, { timeout: 90000 })
            .toBe("rollback_unhealthy");
        expect(fs.readFileSync(app.file, "utf8")).toBe(app.before);
        await expect(panel).toContainText(tr("projectRecoveryStatus_rollback_unhealthy"));
        await expect(panel).not.toContainText("projectSiteRecoveryAction_undefined");
        await page.screenshot({
            path: path.join(process.env.KUMA_E2E_DATA_DIR, "site-recovery-rollback.png"),
            fullPage: true,
        });
    } finally {
        await page.close();
        if (projectID && monitorID && socket.connected)
            await call("projectControlMonitor", { projectID, id: monitorID, action: "pause" });
        socket.disconnect();
    }
});
