const { AIError, diagnosisSchema, validateDiagnosis } = require("./openai-client");
const crypto = require("node:crypto");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
    JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                  Object.keys(item)
                      .sort()
                      .map((key) => [key, item[key]])
              )
            : item
    ).replace(/[^\x00-\x7f]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
const relativePath = /^[A-Za-z0-9_@.()[\]/-]{1,250}$/;
const protectedPath =
    /(?:^|\/)(?:\.?env[^/]*|secrets?|credentials?|auth[^/]*|accounts|permissions?|security|crypto|migrations?|models?|settings[^/]*|node_modules|\.git)(?:\/|\.|$)/i;
const unsafeCode =
    /(?:child_process|execSync|spawnSync|os\.system|subprocess\.|shell\s*=\s*True|\beval\s*\(|new\s+Function\s*\(|pickle\.loads?|yaml\.load\s*\(|rm\s+-rf|\b(?:DROP|TRUNCATE|ALTER|CREATE)\s+(?:TABLE|DATABASE)|rejectUnauthorized\s*:\s*false|verify\s*=\s*False|_create_unverified_context)/i;
const unsafeTest =
    /(?:process\.(?:exit|stdout|stderr)|sys\.exit|os\._exit|\.skip\s*\(|\.todo\s*\(|unittest\.skip|console\.(?:log|error)|child_process|subprocess\.|os\.system|\beval\s*\(|new\s+Function\s*\(|\bfetch\s*\(|https?\.request|socket\.)/i;

/**
 * @param {string} value Existing relative code path
 * @returns {boolean} Eligible source, never a command or a private settings file
 */
function allowedPath(value) {
    return (
        typeof value === "string" &&
        relativePath.test(value) &&
        !value.startsWith("/") &&
        !value.split("/").some((part) => ["", ".", ".."].includes(part)) &&
        !protectedPath.test(value) &&
        /\.(?:js|mjs|cjs|py|html)$/.test(value)
    );
}

/**
 * @param {object} source Exact consented windows
 * @returns {object} Closed structured proposal, preserving the project's selected model
 */
function schema(source) {
    return {
        ...diagnosisSchema,
        properties: {
            ...diagnosisSchema.properties,
            remediation: {
                type: "object",
                additionalProperties: false,
                properties: {
                    action: { type: "string", enum: ["none", "code_patch"] },
                    reason: { type: "string" },
                    changes: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                path: { type: "string", enum: source.files.map((file) => file.path) },
                                beforeHash: { type: "string" },
                                edits: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: { before: { type: "string" }, after: { type: "string" } },
                                        required: ["before", "after"],
                                    },
                                },
                            },
                            required: ["path", "beforeHash", "edits"],
                        },
                    },
                    test: {
                        type: "object",
                        additionalProperties: false,
                        properties: { language: { type: "string", enum: [source.language] }, code: { type: "string" } },
                        required: ["language", "code"],
                    },
                },
                required: ["action", "reason", "changes", "test"],
            },
        },
        required: [...diagnosisSchema.required, "remediation"],
    };
}

const reviewSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        verdict: { type: "string", enum: ["accept", "reject"] },
        summary: { type: "string" },
        findings: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
                    path: { type: "string" },
                    reason: { type: "string" },
                },
                required: ["severity", "path", "reason"],
            },
        },
        limitations: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "summary", "findings", "limitations"],
};

/**
 * @param {object} value Untrusted model output
 * @param {object} source Exact consented source
 * @returns {object} Bounded patch with no host actions
 * @throws {Error} Invalid or unsafe proposal
 */
function validate(value, source) {
    const patch = value?.remediation;
    if (
        !patch ||
        Object.keys(patch).sort().join(",") !== "action,changes,reason,test" ||
        !["none", "code_patch"].includes(patch.action)
    )
        throw new AIError("response");
    validateDiagnosis(
        {
            ...value,
            remediation: { action: patch.action === "none" ? "none" : "restore_config", reason: patch.reason },
        },
        true
    );
    if (
        !Array.isArray(patch.changes) ||
        patch.changes.length > 4 ||
        !patch.test ||
        Object.keys(patch.test).sort().join(",") !== "code,language" ||
        patch.test.language !== source.language ||
        typeof patch.test.code !== "string" ||
        Buffer.byteLength(patch.test.code) > 12288 ||
        JSON.stringify(value).length > 48000
    )
        throw new AIError("response");
    if (patch.action === "none") {
        if (patch.changes.length || patch.test.code) throw new AIError("response");
        return value;
    }
    if (
        !patch.changes.length ||
        patch.test.code.length < 30 ||
        unsafeTest.test(patch.test.code) ||
        !/\bassert(?:\w*|\.)/.test(patch.test.code)
    )
        throw new AIError("response");
    const seen = new Set();
    for (const change of patch.changes) {
        const original = source.files.find((file) => file.path === change.path);
        if (
            Object.keys(change).sort().join(",") !== "beforeHash,edits,path" ||
            !allowedPath(change.path) ||
            seen.has(change.path) ||
            !original ||
            original.sha256 !== change.beforeHash ||
            !Array.isArray(change.edits) ||
            change.edits.length < 1 ||
            change.edits.length > 8
        )
            throw new AIError("response");
        seen.add(change.path);
        const needles = new Set();
        for (const edit of change.edits) {
            if (
                !edit ||
                Object.keys(edit).sort().join(",") !== "after,before" ||
                typeof edit.before !== "string" ||
                typeof edit.after !== "string" ||
                !edit.before ||
                edit.before === edit.after ||
                Buffer.byteLength(edit.before) > 4096 ||
                Buffer.byteLength(edit.after) > 8192 ||
                needles.has(edit.before) ||
                !original.windows.some((window) => window.text.includes(edit.before)) ||
                unsafeCode.test(edit.after) ||
                /\u0000/.test(edit.after)
            )
                throw new AIError("response");
            needles.add(edit.before);
        }
    }
    return value;
}

/**
 * @param {object} value Untrusted independent review
 * @returns {object} Bounded decision, never a host instruction
 * @throws {Error} Invalid review
 */
function validateReview(value) {
    if (
        !value ||
        Object.keys(value).sort().join(",") !== "findings,limitations,summary,verdict" ||
        !["accept", "reject"].includes(value.verdict) ||
        typeof value.summary !== "string" ||
        !value.summary.trim() ||
        value.summary.length > 2000 ||
        !Array.isArray(value.findings) ||
        value.findings.length > 12 ||
        !Array.isArray(value.limitations) ||
        value.limitations.length > 8 ||
        value.limitations.some((item) => typeof item !== "string" || item.length > 1500) ||
        value.findings.some(
            (item) =>
                !item ||
                Object.keys(item).sort().join(",") !== "path,reason,severity" ||
                !["low", "medium", "high", "critical"].includes(item.severity) ||
                typeof item.path !== "string" ||
                item.path.length > 250 ||
                typeof item.reason !== "string" ||
                !item.reason.trim() ||
                item.reason.length > 1500
        ) ||
        (value.verdict === "accept" && value.findings.some((item) => ["high", "critical"].includes(item.severity))) ||
        JSON.stringify(value).length > 16000
    )
        throw new AIError("response");
    return value;
}

module.exports = { allowedPath, schema, reviewSchema, validate, validateReview, hash, canonical };
