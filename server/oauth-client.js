const axios = require("axios");

/**
 * Request a client-credentials token without discovery or interactive login.
 * @param {string} tokenEndpoint Token URL.
 * @param {string} clientId Application identifier.
 * @param {string} clientSecret Application secret.
 * @param {string} scope Requested scopes.
 * @param {string} audience Requested audience.
 * @param {string} authMethod Client secret authentication method.
 * @returns {Promise<object>} Token and optional absolute expiry in seconds.
 */
exports.getOidcTokenClientCredentials = async (
    tokenEndpoint,
    clientId,
    clientSecret,
    scope,
    audience,
    authMethod = "client_secret_basic"
) => {
    let endpoint;
    try {
        endpoint = new URL(tokenEndpoint);
    } catch {
        throw new Error("Invalid OAuth token endpoint");
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
        throw new Error("Invalid OAuth token endpoint");
    }
    if (!["client_secret_basic", "client_secret_post"].includes(authMethod)) {
        throw new Error("Unsupported OAuth client authentication method");
    }
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope) {
        form.set("scope", scope);
    }
    if (audience) {
        form.set("audience", audience);
    }
    const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (authMethod === "client_secret_post") {
        form.set("client_id", clientId);
        form.set("client_secret", clientSecret);
    } else {
        // OAuth Basic credentials are form-encoded separately before joining.
        const encode = (value) => new URLSearchParams({ value }).toString().slice(6);
        headers.Authorization =
            "Basic " + Buffer.from(encode(clientId) + ":" + encode(clientSecret)).toString("base64");
    }
    let data;
    try {
        ({ data } = await axios.post(endpoint.href, form.toString(), {
            headers,
            timeout: 10000,
            maxRedirects: 0,
            maxContentLength: 65536,
            proxy: false,
        }));
    } catch (error) {
        // Axios errors contain the request configuration, including credentials.
        throw new Error(
            error.response
                ? "OAuth token request failed (HTTP " + error.response.status + ")"
                : "OAuth token request failed"
        );
    }
    if (
        !data ||
        typeof data.access_token !== "string" ||
        !data.access_token.trim() ||
        typeof data.token_type !== "string" ||
        !data.token_type.trim() ||
        /[\r\n]/.test(data.access_token + data.token_type)
    ) {
        throw new Error("Invalid OAuth token response");
    }
    const token = { access_token: data.access_token, token_type: data.token_type };
    if (data.expires_in !== undefined) {
        const seconds = Number(data.expires_in);
        if (
            (typeof data.expires_in !== "number" && typeof data.expires_in !== "string") ||
            data.expires_in === "" ||
            !Number.isFinite(seconds) ||
            seconds < 0 ||
            seconds > Number.MAX_SAFE_INTEGER - Date.now() / 1000
        ) {
            throw new Error("Invalid OAuth token expiry");
        }
        token.expires_in = seconds;
        token.expires_at = Math.floor(Date.now() / 1000) + seconds;
    }
    return token;
};
