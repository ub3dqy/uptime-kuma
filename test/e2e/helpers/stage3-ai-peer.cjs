// A synthetic OpenAI-compatible peer. It binds only loopback and cannot use a real account.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
if (!folder || !fs.existsSync(path.join(folder, "fixture-cert.pem"))) {
    throw new Error("Missing owned fixture");
}
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-e2e", alg: "RS256", use: "sig" };
const codes = new Map();
const refreshTokens = new Set();
const records = [];
const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const clientID = "synthetic-uptime-kuma-client";
const control = () => {
    try {
        return JSON.parse(fs.readFileSync(path.join(folder, "ai-control.json"), "utf8"));
    } catch {
        return {};
    }
};
/** @returns {string} Never valid with a real provider */
const opaque = () => "synthetic-" + crypto.randomBytes(24).toString("hex");
/**
 * @param {object} response HTTP reply
 * @param {object} value Body
 * @param {number} status Status
 * @returns {void} Bounded JSON reply
 */
function json(response, value, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
}
const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const state = control();
    try {
        let body = "";
        for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 65536) {
                request.destroy();
                return;
            }
        }
        if (url.pathname === "/api/accounts/authorize") {
            const redirect = new URL(url.searchParams.get("redirect_uri"));
            if (
                redirect.protocol !== "http:" ||
                redirect.hostname !== "127.0.0.1" ||
                redirect.pathname !== "/auth/callback" ||
                url.searchParams.get("scope") !== scope
            ) {
                throw new Error();
            }
            const code = opaque();
            codes.set(code, {
                redirectURI: redirect.href,
                nonce: url.searchParams.get("nonce"),
                challenge: url.searchParams.get("code_challenge"),
                clientID:
                    url.searchParams.get("client_id") === "dynamic_agent_client"
                        ? clientID
                        : url.searchParams.get("client_id"),
            });
            redirect.searchParams.set("state", url.searchParams.get("state"));
            redirect.searchParams.set("code", code);
            redirect.searchParams.set("client_id", clientID);
            response.writeHead(302, { Location: redirect.href, "Cache-Control": "no-store" }).end();
            return;
        }
        if (url.pathname === "/.well-known/openid-configuration") {
            json(response, {
                issuer: "https://auth.openai.com",
                jwks_uri: "https://auth.openai.com/synthetic-keys",
                revocation_endpoint: "https://auth.openai.com/synthetic-revoke",
            });
            return;
        }
        if (url.pathname === "/synthetic-keys") {
            json(response, { keys: [jwk] });
            return;
        }
        if (url.pathname === "/api/accounts/oauth/token") {
            const form = new URLSearchParams(body);
            if (form.get("grant_type") === "authorization_code") {
                const pending = codes.get(form.get("code"));
                codes.delete(form.get("code"));
                if (
                    !pending ||
                    pending.redirectURI !== form.get("redirect_uri") ||
                    pending.clientID !== form.get("client_id") ||
                    pending.challenge !==
                        crypto
                            .createHash("sha256")
                            .update(form.get("code_verifier") || "")
                            .digest("base64url")
                ) {
                    json(response, { error: "invalid_grant" }, 400);
                    return;
                }
                const refresh = opaque();
                refreshTokens.add(refresh);
                json(response, {
                    access_token: opaque(),
                    refresh_token: refresh,
                    token_type: "Bearer",
                    scope,
                    expires_in: 3600,
                    id_token: jwt.sign(
                        {
                            iss: "https://auth.openai.com",
                            aud: clientID,
                            sub: "synthetic-project-admin",
                            email: "fixture@example.test",
                            nonce: pending.nonce,
                        },
                        privateKey,
                        { algorithm: "RS256", keyid: jwk.kid, expiresIn: 3600 }
                    ),
                });
                return;
            }
            if (form.get("grant_type") === "refresh_token" && refreshTokens.delete(form.get("refresh_token"))) {
                const refresh = opaque();
                refreshTokens.add(refresh);
                json(response, {
                    access_token: opaque(),
                    refresh_token: refresh,
                    token_type: "Bearer",
                    scope,
                    expires_in: 3600,
                });
                return;
            }
            json(response, { error: "invalid_grant" }, 400);
            return;
        }
        if (url.pathname === "/synthetic-revoke") {
            const form = new URLSearchParams(body);
            refreshTokens.delete(form.get("token"));
            response.writeHead(state.revokeFailure ? 503 : 200).end();
            return;
        }
        if (!/^Bearer synthetic-/.test(request.headers.authorization || "")) {
            json(response, { error: { code: "invalid_api_key" } }, 401);
            return;
        }
        if (url.pathname === "/v1/models") {
            json(response, {
                data: [{ id: "gpt-synthetic-api" }],
                models: [{ slug: "gpt-synthetic-plan", display_name: "Synthetic plan model", visibility: "list" }],
            });
            return;
        }
        if (url.pathname === "/v1/responses") {
            const payload = JSON.parse(body);
            records.push({ at: Date.now(), payload });
            fs.writeFileSync(path.join(folder, "ai-requests.json"), JSON.stringify(records));
            if (state.mode === "auth" || state.mode === "limit") {
                json(response, {}, state.mode === "auth" ? 401 : 429);
                return;
            }
            response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
            if (state.mode === "incomplete") {
                response.end('data: {"type":"response.incomplete"}\n\n');
                return;
            }
            const answer = {
                facts: ["Учебный ответ: получены только разрешённые наблюдения."],
                hypotheses: [
                    {
                        explanation: "Это синтетическая проверка, причина реального сбоя не установлена.",
                        confidence: "low",
                    },
                ],
                nextSteps: ["Проверить реальные наблюдения отдельно."],
                limitations: ["Реальный аккаунт и рабочие сайты не использовались."],
            };
            if (payload.text?.format?.name === "monitor_recovery_proposal") {
                answer.remediation = {
                    action: "restore_config",
                    reason: "Учебное предложение: вернуть разрешённые настройки выбранного приложения и проверить результат.",
                };
            }
            const send = () =>
                response.end(
                    "data: " +
                        JSON.stringify({
                            type: "response.completed",
                            response: {
                                status: "completed",
                                output: [
                                    {
                                        type: "message",
                                        content: [{ type: "output_text", text: JSON.stringify(answer) }],
                                    },
                                ],
                                usage: { input_tokens: 25, output_tokens: 50, total_tokens: 75 },
                            },
                        }) +
                        "\n\n"
                );
            if (state.mode === "slow") {
                setTimeout(send, 3000);
            } else {
                send();
            }
            return;
        }
        json(response, {}, 404);
    } catch {
        if (!response.headersSent) {
            json(response, {}, 400);
        } else {
            response.end();
        }
    }
});
server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(path.join(folder, "ai-control.json"), "{}");
    fs.writeFileSync(path.join(folder, "ai-requests.json"), "[]");
    fs.writeFileSync(
        path.join(folder, "ai-fixture.json"),
        JSON.stringify({ synthetic: true, url: "http://127.0.0.1:" + server.address().port })
    );
    console.log("Owned synthetic AI peer ready on loopback; no real account is used");
});
