const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { OpenAIClient } = require("../../server/projects/openai-client");
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" };
const issuer = "https://auth.openai.com";
const clientID = "synthetic-issued-client";
const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/**
 * @param {object} changes Deliberately invalid identity overrides
 * @returns {string} Locally signed synthetic identity
 */
function identity(changes = {}) {
    return jwt.sign(
        {
            iss: issuer,
            aud: clientID,
            sub: "synthetic-admin",
            email: "synthetic@example.test",
            nonce: "test-nonce",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            ...changes,
        },
        privateKey,
        { algorithm: "RS256", keyid: jwk.kid }
    );
}
/**
 * @param {object} changes Grant overrides
 * @returns {object} Fake credentials, never usable externally
 */
function grant(changes = {}) {
    return {
        token_type: "Bearer",
        scope,
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
        expires_in: 3600,
        id_token: identity(),
        ...changes,
    };
}
/**
 * @param {object} body JSON
 * @param {number} status Status
 * @returns {Response} Native local response
 */
function json(body, status = 200) {
    return Response.json(body, { status });
}
/**
 * @param {Function} extra Per-test endpoint behavior
 * @returns {OpenAIClient} No external network possible
 */
function fakeClient(extra = () => {}) {
    return new OpenAIClient({
        fetch: async (url, options) => {
            if (url === issuer + "/.well-known/openid-configuration") {
                return json({ issuer, jwks_uri: issuer + "/keys", revocation_endpoint: issuer + "/revoke" });
            }
            if (url === issuer + "/keys") {
                return json({ keys: [jwk] });
            }
            const result = await extra(url, options);
            if (result) {
                return result;
            }
            throw new Error("Unexpected endpoint in isolated test");
        },
    });
}
const diagnosis = {
    facts: ["A synthetic observation was supplied."],
    hypotheses: [{ explanation: "No real service was contacted.", confidence: "low" }],
    nextSteps: ["Check a real observation separately."],
    limitations: ["Synthetic test only."],
};
/**
 * @param {object} changes Protocol overrides
 * @returns {object} Complete synthetic response
 */
function completion(changes = {}) {
    return {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(diagnosis) }] }],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        ...changes,
    };
}
/**
 * @param {object[]} events Events in order
 * @param {boolean} keepOpen Verify stopping at completion without EOF
 * @returns {Response} Split byte stream
 */
function stream(events, keepOpen = false) {
    const bytes = Buffer.from(events.map((event) => "data: " + JSON.stringify(event) + "\r\n\r\n").join(""));
    return new Response(
        new ReadableStream({
            start(controller) {
                for (let i = 0; i < bytes.length; i += 7) {
                    controller.enqueue(bytes.subarray(i, i + 7));
                }
                if (!keepOpen) {
                    controller.close();
                }
            },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
    );
}
module.exports = { fakeClient, identity, grant, jwk, issuer, clientID, scope, json, diagnosis, completion, stream };
