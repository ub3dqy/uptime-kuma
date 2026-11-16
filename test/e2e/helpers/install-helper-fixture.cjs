// Test-only transport for executing the unchanged downloadable helper.
const fs = require("node:fs");
const path = require("node:path");
const data = process.env.KUMA_E2E_DATA_DIR || "";
if (!/^private\/e2e-workspace-[a-f0-9]{12}$/.test(data)) {
    throw new Error("Foreign helper fixture refused");
}
const config = JSON.parse(fs.readFileSync(path.resolve(data, "peer/ai-fixture.json"), "utf8"));
const target = new URL(config.url);
if (!config.synthetic || target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.pathname !== "/") {
    throw new Error("Nonlocal helper fixture refused");
}
const original = globalThis.fetch;
globalThis.fetch = (url, options) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://auth.openai.com" && parsed.pathname === "/api/accounts/oauth/token") {
        return original(new URL(parsed.pathname, target), options);
    }
    if (
        parsed.protocol === "http:" &&
        parsed.hostname === "127.0.0.1" &&
        parsed.pathname.startsWith("/api/project-ai/import/")
    ) {
        return original(parsed, options);
    }
    throw new Error("External helper test request refused");
};
