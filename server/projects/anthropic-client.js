const { AIError, diagnosisRequest, parseDiagnosisAnswer, responseText } = require("./openai-client");

const origin = "https://api.anthropic.com";
const version = "2026-10-21";
const modelID = /^claude-[a-z0-9][a-z0-9._-]{1,120}$/;

class AnthropicClient {
    /** @param {object} options Official provider transport, possibly via the isolated worker */
    constructor(options = {}) {
        this.fetch = options.fetch || fetch;
    }

    /**
     * @param {string} path Fixed provider path
     * @param {string} token User's Anthropic key
     * @param {AbortSignal} signal Request deadline
     * @param {object|null} body Structured request, if any
     * @returns {Promise<object>} Bounded provider response
     */
    async request(path, token, signal, body = null) {
        let response;
        try {
            response = await this.fetch(origin + path, {
                method: body ? "POST" : "GET",
                headers: {
                    "x-api-key": token,
                    "anthropic-version": version,
                    "content-type": "application/json",
                    accept: "application/json",
                },
                body: body ? JSON.stringify(body) : undefined,
                redirect: "error",
                signal,
            });
        } catch {
            throw new AIError(signal?.aborted ? "timeout" : "unavailable");
        }
        if (!response.ok) {
            await response.body?.cancel();
            if ([401, 403].includes(response.status)) {
                throw new AIError("auth");
            }
            if ([402, 429].includes(response.status)) {
                throw new AIError("limit");
            }
            throw new AIError(response.status === 400 ? "response" : "unavailable");
        }
        try {
            return JSON.parse(await responseText(response, 524288));
        } catch {
            throw new AIError(signal?.aborted ? "timeout" : "response");
        }
    }

    /**
     * @param {string} token User's Anthropic key
     * @param {string} _mode Anthropic API
     * @param {AbortSignal} signal Catalog deadline
     * @returns {Promise<object[]>} Models provided by this key with structured answers
     */
    async models(token, _mode, signal) {
        const models = new Map();
        let cursor = "";
        for (let page = 0; page < 4; page++) {
            const query = new URLSearchParams({ limit: "100" });
            if (cursor) {
                query.set("after_id", cursor);
            }
            const data = await this.request("/v1/models?" + query, token, signal);
            if (!Array.isArray(data?.data) || typeof data.has_more !== "boolean") {
                throw new AIError("response");
            }
            for (const model of data.data) {
                if (
                    typeof model?.id === "string" &&
                    modelID.test(model.id) &&
                    model.capabilities?.structured_outputs?.supported === true &&
                    !["deprecated", "retired"].includes(model.lifecycle)
                ) {
                    const name = typeof model.display_name === "string" ? model.display_name : model.id;
                    models.set(model.id, {
                        id: model.id,
                        label: name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || model.id,
                    });
                }
            }
            if (!data.has_more) {
                return [...models.values()];
            }
            if (typeof data.last_id !== "string" || !modelID.test(data.last_id) || data.last_id === cursor) {
                throw new AIError("response");
            }
            cursor = data.last_id;
        }
        throw new AIError("response");
    }

    /**
     * @param {object} config Saved project, model and limits
     * @param {string} token User's Anthropic key
     * @param {object} evidence Already authorized and filtered monitoring data
     * @param {AbortSignal} signal Request deadline
     * @returns {Promise<object>} Completed and validated result with measured usage
     */
    async diagnose(config, token, evidence, signal) {
        if (config.mode !== "anthropic" || !modelID.test(config.model)) {
            throw new AIError("auth");
        }
        const request = diagnosisRequest(config, evidence);
        const body = {
            model: config.model,
            max_tokens: config.max_output_tokens,
            system: request.instructions,
            messages: request.input,
            output_config: { format: { type: "json_schema", schema: request.text.format.schema } },
        };
        if (Buffer.byteLength(JSON.stringify(body)) > 90000) {
            throw new AIError("response");
        }
        const answer = await this.request("/v1/messages", token, signal, body);
        if (answer?.stop_reason === "refusal") {
            throw new AIError("refused");
        }
        if (answer?.stop_reason !== "end_turn" || !Array.isArray(answer.content)) {
            throw new AIError("incomplete");
        }
        const text = answer.content.filter((part) => part?.type === "text" && typeof part.text === "string");
        if (text.length !== 1) {
            throw new AIError("response");
        }
        const result = parseDiagnosisAnswer(text[0].text, evidence);
        const usage = { input_tokens: null, output_tokens: null, total_tokens: null };
        for (const key of ["input_tokens", "output_tokens"]) {
            const count = answer.usage?.[key];
            if (Number.isSafeInteger(count) && count >= 0) {
                usage[key] = count;
            }
        }
        if (
            usage.input_tokens !== null &&
            usage.output_tokens !== null &&
            Number.isSafeInteger(usage.input_tokens + usage.output_tokens)
        ) {
            usage.total_tokens = usage.input_tokens + usage.output_tokens;
        }
        return { result, usage };
    }
}

module.exports = { AnthropicClient };
