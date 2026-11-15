const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { OpenAIClient, AIError } = require("../../server/projects/openai-client");
const {
    fakeClient,
    identity,
    grant,
    clientID,
    scope,
    json,
    diagnosis,
    completion,
    stream,
} = require("../fixtures/openai-grant.cjs");
const signal = () => AbortSignal.timeout(5000);

test("official authorization uses a fresh PKCE challenge, direct scope and issued registration", () => {
    const client = new OpenAIClient();
    const base = {
        hostID: "urn:uuid:00000000-0000-4000-8000-000000000000",
        redirectURI: "http://127.0.0.1:1234/auth/callback",
        state: "fresh-state",
        nonce: "fresh-nonce",
        verifier: "fresh-verifier",
    };
    const url = new URL(client.authorizeURL(base));
    assert.equal(url.origin, "https://auth.openai.com");
    assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(url.searchParams.get("agent_name_hint"), "Uptime Kuma");
    assert.equal(url.searchParams.get("scope"), scope);
    assert.equal(
        url.searchParams.get("code_challenge"),
        crypto.createHash("sha256").update(base.verifier).digest("base64url")
    );
    assert.equal(new URL(client.authorizeURL({ ...base, clientID })).searchParams.get("agent_name_hint"), null);
    for (const redirectURI of [
        "http://localhost:1234/auth/callback",
        "https://127.0.0.1/auth/callback",
        "http://127.0.0.1:1234/wrong",
    ]) {
        assert.throws(() => client.authorizeURL({ ...base, redirectURI }));
    }
});

test("ID token validation checks signature, issuer, audience, expiry, nonce, scopes and subject", async () => {
    const client = fakeClient();
    const valid = await client.validateTokens(grant(), { clientID, nonce: "test-nonce" });
    assert.equal(valid.subject, "synthetic-admin");
    assert.equal(valid.kind, "subscription");
    for (const changes of [
        { iss: "https://attacker.test" },
        { aud: "another-client" },
        { nonce: "wrong" },
        { exp: Math.floor(Date.now() / 1000) - 90 },
        { sub: "" },
        { aud: [clientID, "another-client"], azp: "wrong" },
    ]) {
        await assert.rejects(
            client.validateTokens(grant({ id_token: identity(changes) }), { clientID, nonce: "test-nonce" }),
            /auth/
        );
    }
    await assert.rejects(client.validateTokens(grant({ scope: "openid profile email" }), { clientID }), /auth/);
    await assert.rejects(client.validateTokens(grant(), { clientID: "dynamic_agent_client" }), /auth/);
    await assert.rejects(client.validateTokens(grant(), { clientID, subject: "another-account" }), /auth/);
    const tampered = grant();
    tampered.id_token = tampered.id_token.slice(0, -20) + "x".repeat(20);
    await assert.rejects(client.validateTokens(tampered, { clientID }), /auth/);
    await assert.rejects(client.validateTokens(grant({ expires_in: 1e20 }), { clientID }), /auth/);
});

test("refresh rotates tokens without borrowing identity or requiring a new ID token", async () => {
    let sent;
    const client = fakeClient((_url, options) => {
        sent = new URLSearchParams(options.body);
        return json(
            grant({
                id_token: undefined,
                access_token: "replacement-access",
                refresh_token: "replacement-refresh",
                scope: undefined,
            })
        );
    });
    const old = await client.validateTokens(grant(), { clientID });
    old.id_token = identity({ exp: Math.floor(Date.now() / 1000) - 90 });
    const updated = await client.refresh(old, signal());
    assert.equal(sent.get("client_id"), clientID);
    assert.equal(sent.get("refresh_token"), old.refresh_token);
    assert.equal(sent.has("scope"), false);
    assert.equal(updated.refresh_token, "replacement-refresh");
    assert.equal(updated.subject, old.subject);
    assert.equal(updated.id_token, old.id_token);
    const switched = fakeClient(() => json(grant({ id_token: identity({ sub: "another-account" }) })));
    await assert.rejects(switched.refresh(old, signal()), /auth/);
    const missing = fakeClient(() => json(grant({ id_token: undefined, refresh_token: "" })));
    await assert.rejects(missing.refresh(old, signal()), /auth/);
});

test("stream completion accepts split UTF-8 and stops at the terminal event without waiting for EOF", async () => {
    let request;
    const client = fakeClient((_url, options) => {
        request = JSON.parse(options.body);
        return stream(
            [
                { type: "response.output_text.delta", delta: "ignored partial" },
                { type: "response.completed", response: completion() },
            ],
            true
        );
    });
    const result = await client.diagnose(
        { mode: "api", model: "synthetic-model", max_output_tokens: 512 },
        "synthetic-secret",
        {},
        signal()
    );
    assert.deepEqual(result.result, diagnosis);
    assert.equal(result.usage.total_tokens, 30);
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    assert.deepEqual(request.tools, []);
    assert.equal(request.max_output_tokens, 512);
    await client.diagnose({ mode: "subscription", model: "synthetic-model" }, "synthetic-token", {}, signal());
    assert.equal(Object.hasOwn(request, "max_output_tokens"), false);
    assert.equal(Object.hasOwn(request, "temperature"), false);
});

test("partial, incomplete, refused, malformed and oversized output never counts as a successful request", async () => {
    for (const events of [
        [{ type: "response.output_text.delta", delta: "partial" }],
        [{ type: "response.incomplete" }],
        [{ type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } }],
        [{ type: "response.completed", response: completion({ status: "incomplete" }) }],
        [
            {
                type: "response.completed",
                response: completion({ output: [{ type: "message", content: [{ type: "refusal" }] }] }),
            },
        ],
        [
            {
                type: "response.completed",
                response: completion({
                    output: [{ type: "message", content: [{ type: "output_text", text: '{"facts":[]}' }] }],
                }),
            },
        ],
    ]) {
        const client = fakeClient(() => stream(events));
        await assert.rejects(client.diagnose({ mode: "api", model: "synthetic" }, "token", {}, signal()), AIError);
    }
    const large = fakeClient(
        () => new Response("data: " + "x".repeat(524289), { headers: { "Content-Type": "text/event-stream" } })
    );
    await assert.rejects(large.diagnose({ mode: "api", model: "synthetic" }, "token", {}, signal()), /response/);
});

test("models are account-specific and revocation is never reported as confirmed after a failed response", async () => {
    const client = fakeClient((url) =>
        url.endsWith("/models")
            ? json({
                  models: [
                      { slug: "synthetic-plan", display_name: "Plan model", visibility: "list" },
                      { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
                  ],
                  data: [{ id: "gpt-synthetic-api" }],
              })
            : json({}, 503)
    );
    assert.deepEqual(
        (await client.models("token", "subscription", signal())).map((row) => row.id),
        ["synthetic-plan"]
    );
    assert.deepEqual(
        (await client.models("token", "api", signal())).map((row) => row.id),
        ["gpt-synthetic-api"]
    );
    assert.equal(await client.revoke({ client_id: clientID, refresh_token: "synthetic-refresh" }), false);
    const accepted = fakeClient(() => new Response(null, { status: 200 }));
    assert.equal(await accepted.revoke({ client_id: clientID, refresh_token: "synthetic-refresh" }), true);
});

test("downloaded sign-in helper has only built-in dependencies and cannot read another app's session", () => {
    const helper = fs.readFileSync(require.resolve("../../extra/project-ai-sign-in.cjs"), "utf8");
    const imports = [...helper.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
    assert.deepEqual(imports, ["node:fs", "node:http", "node:crypto"]);
    for (const forbidden of ["auth.json", "CODEX_HOME", "OPENAI_API_KEY", "chatgpt.com/backend-api"]) {
        assert.equal(helper.includes(forbidden), false);
    }
});

test("the rich subscription model catalog fits its explicit bound without loosening token-response limits", async () => {
    const client = fakeClient(() =>
        json({
            models: [{ slug: "gpt-synthetic", display_name: "Synthetic", visibility: "list" }],
            capabilities: "x".repeat(700000),
        })
    );
    assert.deepEqual(
        (await client.models("token", "subscription", signal())).map((item) => item.id),
        ["gpt-synthetic"]
    );
    await assert.rejects(client.json("https://api.openai.com/v1/models"), /response/);
    const tooLarge = fakeClient(() => new Response("x".repeat(2097153)));
    await assert.rejects(tooLarge.models("token", "subscription", signal()), /response/);
});

test("a missing MIME header still requires a valid completed SSE response", async () => {
    const client = fakeClient(
        () => new Response(stream([{ type: "response.completed", response: completion() }]).body)
    );
    assert.deepEqual(
        (await client.diagnose({ mode: "subscription", model: "synthetic" }, "token", {}, signal())).result,
        diagnosis
    );
    const malformed = fakeClient(
        () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(Buffer.from("not an event stream"));
                        controller.close();
                    },
                })
            )
    );
    await assert.rejects(
        malformed.diagnose({ mode: "subscription", model: "synthetic" }, "token", {}, signal()),
        AIError
    );
});

test("terminal completion may refer to previously finished output items and never accepts partial deltas", async () => {
    const message = { ...completion().output[0], status: "completed", role: "assistant", phase: "final_answer" };
    const client = fakeClient(() =>
        stream([
            {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                    ...message,
                    phase: "analysis",
                    content: [{ type: "output_text", text: "Private analysis is not a final answer." }],
                },
            },
            { type: "response.output_item.done", output_index: 1, item: message },
            { type: "response.completed", response: completion({ output: [] }) },
        ])
    );
    assert.deepEqual(
        (await client.diagnose({ mode: "subscription", model: "synthetic" }, "token", {}, signal())).result,
        diagnosis
    );
    const unfinished = fakeClient(() =>
        stream([
            { type: "response.output_text.delta", delta: JSON.stringify(diagnosis) },
            { type: "response.completed", response: completion({ output: [] }) },
        ])
    );
    await assert.rejects(
        unfinished.diagnose({ mode: "subscription", model: "synthetic" }, "token", {}, signal()),
        /response/
    );
});
