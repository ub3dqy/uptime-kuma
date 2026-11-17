import { expect, test } from "@playwright/test";
import { io } from "socket.io-client";
import { e2eOwnerPassword, getSetupCode } from "../util-test";

test("first run requires the installation code and guides a new owner on a narrow screen", async ({
    browser,
    baseURL,
}) => {
    const context = await browser.newContext({
        locale: "en-US",
        viewport: { width: 390, height: 840 },
        isMobile: true,
        hasTouch: true,
    });
    const socket = io(baseURL, { transports: ["websocket"], reconnection: false });
    const page = await context.newPage();
    try {
        await page.goto("/start");
        await expect(page.getByTestId("getting-started")).toBeHidden();
        const first = { username: "admin", password: e2eOwnerPassword };
        expect((await socket.timeout(5000).emitWithAck("setup", first)).msg).toBe("setupCodeInvalid");
        expect((await socket.timeout(5000).emitWithAck("setup", { ...first, code: "a".repeat(32) })).msg).toBe(
            "setupCodeInvalid"
        );
        const code = getSetupCode();
        expect((await socket.timeout(5000).emitWithAck("setup", { ...first, code, password: "weak" })).msg).toBe(
            "setupPasswordInvalid"
        );

        await page.goto("/setup#code=" + code);
        await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();
        await expect(page.getByLabel("Installation code", { exact: true })).toBeHidden();
        await expect(page).toHaveURL(/\/setup$/);
        await page.getByPlaceholder("Username").fill(first.username);
        await page.getByPlaceholder("Password", { exact: true }).fill(first.password);
        await page.getByPlaceholder("Repeat Password", { exact: true }).fill(first.password);
        await page.getByRole("button", { name: "Create account" }).tap();
        await expect(page.getByTestId("getting-started")).toBeVisible();
        expect(() => getSetupCode()).toThrow();
        expect((await socket.timeout(5000).emitWithAck("setup", { ...first, code })).msg).toBe("setupOwnerExists");

        const address = page.getByLabel("Website address");
        await address.fill("https://hidden:secret@example.invalid");
        await page.getByRole("button", { name: "Start monitoring" }).tap();
        await expect(page.getByRole("alert")).toContainText("without a username or password");
        await address.fill(baseURL);
        await page.getByRole("button", { name: "Start monitoring" }).tap();
        await expect(page.getByRole("link", { name: "Open monitor" })).toHaveAttribute("href", /\/dashboard\/\d+/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        await page.getByRole("link", { name: "Configure alerts" }).tap();
        await expect(page.getByRole("heading", { name: "Receive alerts" })).toBeVisible();
        await page.getByRole("link", { name: "Continue to personal AI" }).tap();
        const ai = page.getByTestId("project-ai");
        await expect(ai.getByText("Without AI")).toHaveCount(1);
        const provider = ai.getByRole("combobox").first();
        await provider.selectOption("anthropic");
        await expect(ai.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
        await expect(ai.getByRole("link", { name: "Create a key in Claude Console" })).toBeVisible();
        await provider.selectOption("api");
        await expect(ai.getByRole("link", { name: "Create a key in OpenAI" })).toBeVisible();
        await provider.selectOption("subscription");
        await expect(ai.getByLabel(/API key/)).toHaveCount(0);
        await page.getByRole("link", { name: "Continue to account protection" }).tap();
        await expect(page.getByRole("link", { name: "Open security settings" })).toBeVisible();
        await page.getByRole("link", { name: "Go to overview" }).tap();
        await expect(page).toHaveURL(/\/dashboard$/);
    } finally {
        socket.disconnect();
        await context.close();
    }
});
