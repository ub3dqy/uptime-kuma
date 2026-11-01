import { expect, test } from "@playwright/test";
import net from "node:net";
import { login } from "../util-test";

test("SFTP requires a host fingerprint and preserves it across creation and editing", async ({ page }, testInfo) => {
    // This owned peer closes immediately, so a saved monitor cannot contact a real SSH service.
    const peer = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    try {
        await page.goto("./add");
        await login(page);
        await page.getByTestId("monitor-type-select").selectOption("sftp");
        await page.getByTestId("friendly-name-input").fill("Local SFTP fingerprint persistence");
        await page.getByTestId("hostname-input").fill("127.0.0.1");
        await page.locator("#port").fill(String(peer.address().port));
        await page.locator("#ssh_username").fill("local-fixture");
        await page.locator("#ssh_password input").fill("local-fixture");
        const field = page.locator("#ssh_host_key_fingerprint");
        expect(await field.evaluate((input) => input.checkValidity())).toBe(false);
        await field.fill("invalid fingerprint");
        expect(await field.evaluate((input) => input.checkValidity())).toBe(false);
        const fingerprint = "SHA256:" + Buffer.alloc(32, 3).toString("base64").replace(/=$/, "");
        await field.fill(fingerprint);
        expect(await field.evaluate((input) => input.checkValidity())).toBe(true);
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*");
        await page.getByRole("link", { name: "Edit", exact: true }).click();
        await expect(page.locator("#ssh_host_key_fingerprint")).toHaveValue(fingerprint);
        const replacement = "SHA256:" + Buffer.alloc(32, 4).toString("base64").replace(/=$/, "");
        await page.locator("#ssh_host_key_fingerprint").fill(replacement);
        await page.getByTestId("save-button").click();
        await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.locator("#ssh_host_key_fingerprint")).toHaveValue(replacement);
        await page.screenshot({ path: testInfo.outputPath("sftp-host-fingerprint.png"), fullPage: true });
    } finally {
        await new Promise((resolve) => peer.close(resolve));
    }
});
