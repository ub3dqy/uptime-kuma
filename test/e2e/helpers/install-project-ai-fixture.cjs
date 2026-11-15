// Loaded explicitly by the Playwright test command, never by the application.
if (require("node:worker_threads").isMainThread) {
    const fs = require("node:fs");
    const path = require("node:path");
    const data = process.env.KUMA_E2E_DATA_DIR || "";
    if (
        process.env.NODE_ENV !== "development" ||
        !/^private\/e2e-workspace-[a-f0-9]{12}$/.test(data) ||
        !process.argv.includes("--host=127.0.0.1") ||
        !process.argv.includes("--data-dir=./" + data)
    ) {
        throw new Error("Isolated AI transport refused");
    }
    const expectedFolder = path.resolve(data, "peer");
    if (path.resolve(process.env.KUMA_STAGE2_FIXTURE_DIR || "") !== expectedFolder) {
        throw new Error("Foreign fixture refused");
    }
    const config = JSON.parse(fs.readFileSync(path.join(expectedFolder, "ai-fixture.json"), "utf8"));
    const base = new URL(config.url);
    if (
        !config.synthetic ||
        base.protocol !== "http:" ||
        base.hostname !== "127.0.0.1" ||
        base.pathname !== "/" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
    ) {
        throw new Error("Nonlocal peer refused");
    }
    const clientModule = require("../../../server/projects/openai-client");
    const OriginalClient = clientModule.OpenAIClient;
    clientModule.OpenAIClient = class extends OriginalClient {
        constructor() {
            super({
                authorizeBase: new URL("/api/accounts/authorize", base).href,
                fetch: (url, options) => {
                    const original = new URL(url);
                    if (!["https://auth.openai.com", "https://api.openai.com"].includes(original.origin)) {
                        throw new Error("Unexpected fixture endpoint");
                    }
                    return fetch(new URL(original.pathname + original.search, base), { ...options, redirect: "error" });
                },
            });
        }
    };
}
