const TYPES = new Set(["http", "keyword", "json-query"]);
const TranslatableError = require("./translatable-error");

/**
 * Validate an optional HTTP response limit, in milliseconds. Old checks remain unchanged.
 * @param {string} type Monitor type
 * @param {unknown} value Requested limit
 * @returns {number|null} Valid limit
 * @throws {Error} Invalid response-time limit
 */
function responseTimeLimit(type, value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (!TYPES.has(type) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 3600000) {
        throw new TranslatableError("stage2ResponseLimitInvalid");
    }
    return value;
}

/**
 * A successful status code alone does not satisfy an explicitly configured speed check.
 * @param {number|null} limit Valid configured limit
 * @param {number} elapsed Actual request duration
 * @returns {void}
 * @throws {Error} Actual response exceeds the configured limit
 */
function enforceResponseTime(limit, elapsed) {
    if (limit !== null && limit !== undefined && elapsed > limit) {
        throw new Error(`RESPONSE_TIME_LIMIT: ${Math.round(elapsed)} ms > ${limit} ms`);
    }
}

module.exports = { responseTimeLimit, enforceResponseTime };
