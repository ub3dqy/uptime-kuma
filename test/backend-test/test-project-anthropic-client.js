const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AnthropicClient } = require("../../server/projects/anthropic-client");
const { validateRequest } = require("../../server/ai-worker/protocol");

const mode = "anthropic";
const key = "test-claude-key-not-a-real-credential";
const model = "claude-test-model";
const config = { mode, model, max_output_tokens: 512 };
const result = { facts: ["Test only"], hypotheses: [], nextSteps: [], limitations: [] };

/**
 * @param {object} value Test provider payload
 * @returns {Response} Synthetic JSON response
 */
function payload(value) {
    return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

test("Claude uses official routes, account model capabilities and validated structured output", async () => {
    const paths = [];
    const client = new AnthropicClient({
        fetch: async (url, options) => {
            const parsed = new URL(url);
            assert.equal(parsed.origin, "https://api.anthropic.com");
            assert.equal(options.headers["x-api-key"], key);
            assert.equal(options.headers["anthropic-version"], "2026-10-21");
            assert.equal(options.redirect, "error");
            assert.equal("authorization" in options.headers, false);
            validateRequest({
                action: "fetch",
                url,
                method: options.method,
                headers: options.headers,
                body: options.body ?? null,
            });
            paths.push(parsed.pathname);
            if (parsed.pathname === "/v1/models") {
                return payload({
                    data: [
                        {
                            id: model,
                            display_name: "Test model",
                            capabilities: { structured_outputs: { supported: true } },
                        },
                        {
                            id: "claude-old-model",
                            lifecycle: "retired",
                            capabilities: { structured_outputs: { supported: true } },
                        },
                        { id: "claude-unsupported", display_name: "Unsupported" },
                    ],
                    has_more: false,
                });
            }
            const body = JSON.parse(options.body);
            assert.equal(body.model, model);
            assert.equal(body.max_tokens, 512);
            assert.equal(body.output_config.format.type, "json_schema");
            assert.equal(body.output_config.format.schema.additionalProperties, false);
            assert.equal(Object.hasOwn(body, "tools"), false);
            assert.equal(JSON.stringify(body).includes(key), false);
            return payload({
                stop_reason: "end_turn",
                content: [{ type: "text", text: JSON.stringify(result) }],
                usage: { input_tokens: 10, output_tokens: 2 },
            });
        },
    });
    assert.deepEqual(await client.models(key, mode, AbortSignal.timeout(1000)), [{ id: model, label: "Test model" }]);
    const evidence = { probe: "synthetic" };
    assert.deepEqual(await client.diagnose(config, key, evidence, AbortSignal.timeout(1000)), {
        result,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    assert.deepEqual(paths, ["/v1/models", "/v1/messages"]);
});

test("Claude authorization, provider paths, refusal and partial responses fail closed", async () => {
    for (const [reason, error] of [
        ["max_tokens", "incomplete"],
        ["refusal", "refused"],
        ["tool_use", "incomplete"],
    ]) {
        const client = new AnthropicClient({ fetch: async () => payload({ stop_reason: reason, content: [] }) });
        await assert.rejects(client.diagnose(config, key, { probe: "synthetic" }, AbortSignal.timeout(1000)), {
            code: error,
        });
    }
    const envelope = {
        action: "fetch",
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": key, "anthropic-version": "2026-10-21" },
        body: "{}",
    };
    assert.throws(() => validateRequest({ ...envelope, url: "https://api.anthropic.com/v1/elsewhere" }));
    assert.throws(() => validateRequest({ ...envelope, url: "https://api.openai.com/v1/responses" }));
    assert.throws(() =>
        validateRequest({ ...envelope, headers: { ...envelope.headers, authorization: "Bearer other" } })
    );
});
