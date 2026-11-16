// Complete the documented Sign in with ChatGPT loopback flow on the browser's computer.
// The pairing file is downloaded explicitly by the project's administrator.
const fs = require("node:fs");
const http = require("node:http");
const { randomBytes, createHash } = require("node:crypto");

/**
 * This downloadable helper runs with Node alone; it never reads another tool's credentials.
 * @param {Response} response HTTPS reply
 * @param {number} maximum Maximum body bytes
 * @returns {Promise<string>} Bounded text
 */
async function responseText(response, maximum) {
    if (!response.body || Number(response.headers.get("content-length")) > maximum) {
        await response.body?.cancel();
        throw new Error();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) {
                break;
            }
            size += part.value.byteLength;
            if (size > maximum) {
                throw new Error();
            }
            chunks.push(Buffer.from(part.value));
        }
        return Buffer.concat(chunks).toString("utf8");
    } finally {
        await reader.cancel().catch(() => {});
    }
}

/**
 * @param {object} options Explicit pairing and fresh PKCE values
 * @returns {string} Official sign-in URL
 */
function authorizeURL(options) {
    const clientID = options.clientID || "dynamic_agent_client";
    const url = new URL("https://auth.openai.com/api/accounts/authorize");
    url.search = new URLSearchParams({
        client_id: clientID,
        ext_agent_host_id: options.hostID,
        response_type: "code",
        redirect_uri: options.redirectURI,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        resource: "https://api.openai.com/v1",
        state: options.state,
        nonce: options.nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(options.verifier).digest("base64url"),
        ...(clientID === "dynamic_agent_client" ? { agent_name_hint: "Uptime Kuma" } : {}),
    }).toString();
    return url.href;
}

/** @returns {Promise<void>} Sign in without reading any existing account or token file */
async function main() {
    const filename = process.argv[2];
    if (!filename || fs.statSync(filename).size > 10000) {
        throw new Error();
    }
    const config = JSON.parse(fs.readFileSync(filename, "utf8"));
    const server = new URL(config.server);
    if (
        config.version !== 1 ||
        server.username ||
        server.password ||
        server.search ||
        server.hash ||
        server.pathname !== "/" ||
        (server.protocol !== "https:" && !(server.protocol === "http:" && server.hostname === "127.0.0.1")) ||
        !/^[a-f0-9]{32}$/.test(config.pairingID) ||
        !/^[a-zA-Z0-9_-]{43}$/.test(config.token) ||
        !/^[a-zA-Z0-9_-]{43}$/.test(config.nonce) ||
        !/^urn:uuid:[a-f0-9-]{36}$/.test(config.hostID) ||
        (config.clientID != null &&
            (!/^[a-zA-Z0-9_-]{3,200}$/.test(config.clientID) || config.clientID === "dynamic_agent_client")) ||
        !Number.isSafeInteger(config.expiresAt) ||
        config.expiresAt <= Date.now()
    ) {
        throw new Error();
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    let redirectURI;
    let busy = false;
    let timeout;
    const listener = http.createServer(async (request, response) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        response.setHeader("Referrer-Policy", "no-referrer");
        if (
            request.method !== "GET" ||
            request.headers.host !== new URL(redirectURI).host ||
            request.url.length > 10000
        ) {
            response.writeHead(400).end("Invalid callback");
            return;
        }
        const callback = new URL(request.url, redirectURI);
        if (
            callback.pathname !== "/auth/callback" ||
            callback.searchParams.getAll("state").length !== 1 ||
            callback.searchParams.get("state") !== state ||
            busy
        ) {
            response.writeHead(400).end("Invalid callback");
            return;
        }
        busy = true;
        try {
            if (
                callback.searchParams.has("error") ||
                callback.searchParams.getAll("code").length !== 1 ||
                callback.searchParams.getAll("client_id").length > 1
            ) {
                throw new Error();
            }
            const clientID = callback.searchParams.get("client_id") || config.clientID;
            if (
                !clientID ||
                !/^[a-zA-Z0-9_-]{3,200}$/.test(clientID) ||
                clientID === "dynamic_agent_client" ||
                (config.clientID && clientID !== config.clientID)
            ) {
                throw new Error();
            }
            const exchanged = await fetch("https://auth.openai.com/api/accounts/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: clientID,
                    code: callback.searchParams.get("code"),
                    code_verifier: verifier,
                    redirect_uri: redirectURI,
                    resource: "https://api.openai.com/v1",
                }).toString(),
                signal: AbortSignal.timeout(30000),
                redirect: "error",
            });
            const tokens = JSON.parse(await responseText(exchanged, 65536));
            if (!exchanged.ok) {
                throw new Error();
            }
            // Credentials travel only to this application's exact configured HTTPS origin.
            const imported = await fetch(new URL(`/api/project-ai/import/${config.pairingID}`, server), {
                method: "POST",
                headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
                body: JSON.stringify({ ...tokens, client_id: clientID }),
                signal: AbortSignal.timeout(60000),
                redirect: "error",
            });
            const result = JSON.parse(await responseText(imported, 4096));
            if (!imported.ok || !result.ok) {
                throw new Error();
            }
            response.end(
                result.remoteRevoked === false
                    ? "Новый вход сохранён. Отзыв прежнего входа не подтверждён; проверьте доступ приложения в настройках ChatGPT."
                    : "Подключение передано вашему серверу. Вернитесь в Uptime Kuma и выполните пробный запрос."
            );
            console.log("Подключение сохранено на сервере. Ключи и токены в файлы этого компьютера не записывались.");
        } catch {
            response
                .writeHead(400)
                .end(
                    "Вход не подтверждён. Проверьте разрешение Uptime Kuma в настройках ChatGPT, затем начните подключение заново."
                );
            process.exitCode = 1;
        } finally {
            clearTimeout(timeout);
            listener.close();
        }
    });
    await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
    });
    redirectURI = `http://127.0.0.1:${listener.address().port}/auth/callback`;
    timeout = setTimeout(
        () => {
            listener.close();
            process.exitCode = 1;
        },
        Math.max(1, Math.min(600000, config.expiresAt - Date.now()))
    );
    console.log("Откройте этот официальный адрес в браузере на этом компьютере:");
    console.log(
        authorizeURL({
            hostID: config.hostID,
            clientID: config.clientID,
            nonce: config.nonce,
            redirectURI,
            state,
            verifier,
        })
    );
    console.log("Вход и согласие подтверждаются только на странице OpenAI. Пароль здесь не вводится.");
}

main().catch(() => {
    console.error(
        "Не удалось подключить подписку. Проверьте файл сопряжения и начните вход заново в Uptime Kuma. Закрытые данные не выводятся."
    );
    process.exitCode = 1;
});
