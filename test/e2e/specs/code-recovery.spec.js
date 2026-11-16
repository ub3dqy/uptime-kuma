import { test, expect } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
const en = JSON.parse(fs.readFileSync("src/lang/en.json"));
const tr = (key) => en[key];

test("code repair UI: exact source consent, separate review, owner approval, live result, export and rollback", async ({
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
        for (let attempt = 0; attempt < 10; attempt++) {
            const reply = await socket.timeout(30000).emitWithAck(event, request);
            if (reply.msg === "projectBusy") {
                await new Promise((r) => setTimeout(r, 200));
                continue;
            }
            expect(reply.ok, `${event}: ${reply.msg}`).toBe(true);
            return reply;
        }
        throw new Error("Project remained busy");
    };
    let projectID;
    let monitorID;
    try {
        if (await socket.timeout(10000).emitWithAck("needSetup"))
            expect((await socket.timeout(10000).emitWithAck("setup", "admin", "admin123")).ok).toBe(true);
        const login = await call("login", { username: "admin", password: "admin123", token: "" });
        const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
        const app = JSON.parse(fs.readFileSync(path.join(folder, "recovery-fixture.json"))).apps.code;
        projectID = (await call("projectCreate", { name: "Isolated code repair", allowedIPs: ["127.0.0.1"] })).id;
        monitorID = (
            await call("projectSaveMonitor", {
                projectID,
                name: "Functional code fixture",
                type: "http",
                url: app.url,
                interval: 20,
                maxretries: 0,
            })
        ).id;
        let settings = (await call("projectAISettings", { projectID })).settings;
        settings = (
            await call("projectAISave", {
                ...settings,
                projectID,
                mode: "api",
                apiKey: "synthetic-code-api-key",
                dailyLimit: 10,
            })
        ).settings;
        await call("projectAIModels", { projectID, revision: settings.revision });
        settings = (await call("projectAISave", { ...settings, projectID, model: "gpt-synthetic-api" })).settings;
        await call("projectAIEnqueue", { projectID, revision: settings.revision, kind: "probe" });
        await expect
            .poll(async () => (await call("projectAISettings", { projectID })).settings.state, { timeout: 20000 })
            .toBe("verified");
        fs.writeFileSync(
            path.join(folder, "site-recovery.json"),
            JSON.stringify({
                synthetic: true,
                code: true,
                file: app.file,
                baseline: app.baseline,
                targets: [
                    {
                        id: "code-fixture",
                        projectID,
                        monitorID,
                        ownerID: 1,
                        title: "Owned code fixture",
                        action: "restart_service",
                        fingerprint: "a".repeat(64),
                        verifySeconds: 65,
                        checkURL: app.url,
                    },
                ],
            })
        );
        await expect
            .poll(async () => (await call("projectCodeRecoveryGet", { projectID })).executorReady, { timeout: 15000 })
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
        const panel = page.getByTestId("project-code-recovery");
        await expect(panel.getByLabel(tr("projectRecoveryApplication"))).toHaveValue("code-fixture");
        await panel
            .getByLabel(tr("codeRecoveryProblem"), { exact: true })
            .fill("For input 2 the function returns 3; the expected result is 4.");
        await panel.getByRole("button", { name: tr("codeRecoveryChooseFiles"), exact: true }).click();
        await panel.getByRole("checkbox", { name: /availability.cjs/ }).check();
        await panel.getByRole("button", { name: tr("codeRecoveryPreview"), exact: true }).click();
        const source = panel.getByTestId("code-source-preview");
        await expect(source).toContainText(tr("codeRecoveryConsentHelp"));
        await expect(source.getByRole("button", { name: tr("codeRecoveryGenerate"), exact: true })).toBeDisabled();
        expect(fs.readFileSync(app.file, "utf8")).toBe(app.before);
        await source.getByRole("checkbox").check();
        await source.getByRole("button", { name: tr("codeRecoveryGenerate"), exact: true }).click();
        await expect(panel).toContainText(tr("codeRecoveryStatus_planned"), { timeout: 30000 });
        expect(fs.readFileSync(app.file, "utf8")).toBe(app.before);
        await page
            .locator(".ws-project-tabs")
            .getByRole("button", { name: tr("projectTab_ai"), exact: true })
            .click();
        await page
            .getByRole("link", { name: tr("codeRecoveryOpenDetails"), exact: true })
            .first()
            .click();
        await expect(panel).toBeVisible();
        await panel.getByRole("button", { name: tr("codeRecoveryReviewInstall"), exact: true }).click();
        const confirmation = panel.getByTestId("code-owner-confirm");
        await expect(panel.getByTestId("code-plan-details")).toContainText("n + 2");
        await expect(
            confirmation.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true })
        ).toBeDisabled();
        await confirmation.getByRole("checkbox").check();
        await confirmation.getByLabel("Current Password", { exact: true }).fill("admin123");
        await confirmation.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
        await expect
            .poll(async () => (await call("projectCodeRecoveryGet", { projectID })).jobs[0]?.status, { timeout: 80000 })
            .toBe("succeeded");
        expect(await (await fetch(app.url)).text()).toBe("4");
        const job = (await call("projectCodeRecoveryGet", { projectID })).jobs[0];
        expect(job.verification.observations).toHaveLength(2);
        expect(job.backup.expiresAt).toBe(null);
        const downloading = page.waitForEvent("download");
        await panel.getByRole("button", { name: tr("codeRecoveryExport"), exact: true }).click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe(`site-code-fix-${job.id}.json`);
        const file = path.join(process.env.KUMA_E2E_DATA_DIR, "code-export.json");
        await download.saveAs(file);
        expect(JSON.parse(fs.readFileSync(file)).patch.action).toBe("code_patch");
        await page.screenshot({
            path: path.join(process.env.KUMA_E2E_DATA_DIR, "code-recovery-success.png"),
            fullPage: true,
        });
        await panel.getByRole("button", { name: tr("codeRecoveryReturn"), exact: true }).click();
        await confirmation.getByRole("checkbox").check();
        await confirmation.getByLabel("Current Password", { exact: true }).fill("admin123");
        await confirmation.getByRole("button", { name: tr("projectRecoveryConfirm"), exact: true }).click();
        await expect
            .poll(async () => (await call("projectCodeRecoveryGet", { projectID })).jobs[0]?.status, { timeout: 80000 })
            .toBe("rolled_back");
        expect(await (await fetch(app.url)).text()).toBe("3");
        expect(fs.readFileSync(app.file, "utf8")).toBe(app.before);
        await expect(panel).toContainText(tr("codeRecoveryRollbackVerified"));
    } finally {
        await page.close();
        if (projectID && monitorID && socket.connected)
            await call("projectControlMonitor", { projectID, id: monitorID, action: "pause" });
        socket.disconnect();
    }
});
