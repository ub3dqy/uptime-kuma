import { expect, test } from "@playwright/test";
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { e2eOwnerPassword, getSetupCode, login } from "../util-test";

test("explicit work, its local email notices, responsive card and real post-update failure/recovery", async ({
    page,
    baseURL,
}, testInfo) => {
    test.setTimeout(180000);
    const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
    const peer = JSON.parse(fs.readFileSync(path.join(folder, "fixture.json"), "utf8"));
    expect(peer.synthetic).toBe(true);
    const socket = io(baseURL, { transports: ["websocket"], autoConnect: false, reconnection: false });
    const call = async (event, ...args) => {
        const response = await socket.timeout(12000).emitWithAck(event, ...args);
        expect(response.ok, event + " rejected").toBe(true);
        return response;
    };
    await new Promise((resolve, reject) => {
        socket.once("info", resolve);
        socket.once("connect_error", reject);
        socket.connect();
    });
    let db; let monitorID; let sourceTimer;
    const feed = path.resolve(process.env.KUMA_E2E_DATA_DIR, "site-work.json");
    const inbox = () =>
        JSON.parse(fs.readFileSync(path.join(folder, "messages.json"), "utf8")).map((message) => {
            const split = message.body.search(/\r?\n\r?\n/);
            const headers = message.body.slice(0, split);
            const body = message.body.slice(split).trim();
            let decoded = body;
            if (/^Content-Transfer-Encoding: base64$/im.test(headers))
                decoded = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
            else if (/^Content-Transfer-Encoding: quoted-printable$/im.test(headers)) {
                const bytes = body
                    .replace(/=\r?\n/g, "")
                    .replace(/=([a-f\d]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
                decoded = Buffer.from(bytes, "latin1").toString("utf8");
            }
            return { ...message, body: decoded };
        });
    const control = (mode) =>
        fs.writeFileSync(path.join(folder, "control.json"), JSON.stringify({ mode, rejectMail: false }));
    let currentSource;
    const refresh = () => {
        const row = { monitorID, ownerID: 1, host: new URL(peer.http).host, observedAt: Date.now(), ...currentSource };
        fs.writeFileSync(feed + ".next", JSON.stringify({ version: 1, records: [row] }), { mode: 0o600 });
        fs.renameSync(feed + ".next", feed);
    };
    try {
        if (await socket.timeout(10000).emitWithAck("needSetup")) await call("setup", { username: "admin", password: e2eOwnerPassword, code: getSetupCode() });
        await call("login", { username: "admin", password: e2eOwnerPassword, token: "" });
        const project = (await call("projectList", {})).projects.find((item) => item.personal);
        const snapshot = await call("projectSnapshot", { projectID: project.id });
        await call("projectUpdate", {
            projectID: project.id,
            revision: snapshot.project.revision,
            name: snapshot.project.name,
            timezone: "Europe/Moscow",
            allowedIPs: ["127.0.0.1"],
        });
        const settings = await call("getSettings");
        await call("setSettings", { ...settings.data, nscd: false, primaryBaseURL: baseURL }, null);
        control("up");
        monitorID = (
            await call("add", {
                type: "http",
                name: "Site work fixture",
                url: peer.http + "/switch",
                interval: 20,
                retryInterval: 20,
                timeout: 5,
                maxretries: 1,
                active: true,
                accepted_statuscodes: ["200-299"],
                notificationIDList: {},
                method: "GET",
                conditions: [],
                kafkaProducerBrokers: [],
                kafkaProducerSaslOptions: {},
                rabbitmqNodes: [],
                domainExpiryNotification: false,
            })
        ).monitorID;
        db = new Database(process.env.KUMA_E2E_DB_PATH, { fileMustExist: true });
        const latest = () =>
            db.prepare("SELECT * FROM heartbeat WHERE monitor_id=? ORDER BY id DESC LIMIT 1").get(monitorID);
        await expect.poll(() => latest()?.status).toBe(1);
        const channel = (
            await call("saveManagedNotification", {
                config: {
                    type: "smtp",
                    name: "Site work local inbox",
                    smtpHost: "127.0.0.1",
                    smtpPort: peer.smtpPort,
                    smtpSecure: true,
                    smtpUsername: "synthetic-owner",
                    smtpPassword: "fixture-password",
                    smtpFrom: "work-from@example.test",
                    smtpTo: "work-inbox@example.test",
                    locale: "ru",
                },
                monitorIDs: [monitorID],
            })
        ).id;
        currentSource = {
            state: "active",
            work: {
                kind: "update",
                phase: "verifying",
                startedAt: Date.now(),
                deadline: Date.now() + 600000,
                runID: "d".repeat(64),
            },
        };
        refresh();
        sourceTimer = setInterval(refresh, 5000);
        await expect.poll(() => latest()?.status, { timeout: 30000 }).toBe(3);
        await expect
            .poll(() => inbox().some((message) => message.body.includes("Начались плановые работы")), {
                timeout: 15000,
            })
            .toBe(true);
        await page.goto(`/projects/${project.id}?check=${monitorID}`);
        await page.waitForSelector(".workspace-account, input[placeholder='Username']");
        if (await page.getByPlaceholder("Username").isVisible()) await login(page);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const card = page.getByTestId("incident-card");
        await expect(card.getByRole("heading", { name: "Update in progress", exact: true })).toBeVisible();
        await expect(page.getByTestId("site-work")).toContainText("Verifying the new version");
        await expect(page.getByTestId("site-work")).toContainText("Site availability is not confirmed");
        for (const width of [390, 768, 1366]) {
            await page.setViewportSize({ width, height: 1000 });
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await card.screenshot({ path: testInfo.outputPath(`site-work-${width}.png`) });
        }
        control("down");
        const previous = latest().id;
        await expect.poll(() => latest()?.id, { timeout: 30000 }).toBeGreaterThan(previous);
        expect(latest().status).toBe(3);
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM notification_delivery WHERE notification_id=? AND kind='down'")
                .get(channel).n
        ).toBe(0);
        currentSource = { state: "idle" };
        refresh();
        await expect.poll(() => latest()?.status, { timeout: 55000 }).toBe(0);
        await expect
            .poll(() => inbox().some((message) => message.body.includes("Сбой после завершения работ")), {
                timeout: 15000,
            })
            .toBe(true);
        control("up");
        await expect.poll(() => latest()?.status, { timeout: 30000 }).toBe(1);
        await expect
            .poll(() => inbox().some((message) => message.body.includes("Работа восстановлена")), { timeout: 15000 })
            .toBe(true);
        const range = await call("projectPeriodSummary", {
            projectID: project.id,
            monitorID,
            start: new Date(Date.now() - 600000).toISOString(),
            end: new Date().toISOString(),
        });
        expect(range.summary.counts.maintenance).toBeGreaterThan(0);
        expect(range.summary.counts.down).toBeGreaterThan(0);
        expect(range.summary.time.maintenance).toBeGreaterThan(0);
        const deadline = Date.now() - 1000;
        currentSource = {
            state: "active",
            work: { kind: "update", phase: "verifying", startedAt: deadline - 60000, deadline, runID: "e".repeat(64) },
        };
        refresh();
        await expect(page.getByTestId("site-work")).toContainText("Normal checks have resumed", { timeout: 15000 });
        await expect(page.getByTestId("site-work")).not.toContainText("Site availability is not confirmed");
        expect(latest().status).toBe(1);
        expect(errors).toEqual([]);
        expect(inbox().filter((message) => message.body.includes("Начались плановые работы"))).toHaveLength(1);
    } finally {
        clearInterval(sourceTimer);
        if (monitorID && socket.connected) await call("pauseMonitor", monitorID);
        socket.disconnect();
        db?.close();
    }
});
