const http = require("node:http");
const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { R } = require("redbean-node");
const { permit, id, problem, audit } = require("./access");
const { getVault } = require("./vault");
const ai = require("./ai-service");
const listeners = new Map();
const embeddedCallbacks = new Map();
const digest = (value) => createHash("sha256").update(value).digest("hex");

/**
 * @param {string} base Configured application origin
 * @returns {string} Safe secure transfer origin
 * @throws {Error} Invalid value or unavailable protected data
 */
function transferOrigin(base) {
    const url = new URL(base);
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    ) {
        throw problem("projectInvalid");
    }
    return url.origin;
}
/**
 * @param {number} userID Actor
 * @param {object} request Project/config
 * @param {Function} guard Current identity
 * @param {string} base App origin
 * @returns {Promise<object>} One-use local-to-server pairing
 */
async function begin(userID, request, guard, base) {
    const projectID = id(request.projectID);
    const token = randomBytes(32).toString("base64url");
    const pairingID = randomBytes(16).toString("hex");
    const nonce = randomBytes(32).toString("base64url");
    const server = transferOrigin(base);
    return R.knex.transaction(async (tx) => {
        await guard(tx);
        const scope = await permit(userID, projectID, "admin", tx);
        const config = await tx("project_ai")
            .where({ project_id: projectID, revision: request.revision, mode: "subscription" })
            .first();
        if (!config) {
            throw problem("projectChanged");
        }
        let registration = null;
        try {
            registration = JSON.parse(config.registration_json);
        } catch {
            /* First registration. */
        }
        if (request.newAccount === true) {
            registration = null;
        }
        await tx("project_oauth_pairing")
            .where({ project_id: projectID })
            .whereNull("used_at")
            .update({ used_at: Date.now() });
        const expires = Date.now() + 600000;
        await tx("project_oauth_pairing").insert({
            id: pairingID,
            project_id: projectID,
            user_id: userID,
            token_hash: digest(token),
            nonce,
            project_revision: scope.revision,
            config_revision: config.revision,
            expires_at: expires,
            client_id: registration?.client_id || null,
            expected_subject: registration?.subject || null,
        });
        await audit(tx, scope, "aiSignInStarted");
        await guard(tx);
        return {
            version: 1,
            server,
            pairingID,
            token,
            nonce,
            hostID: config.host_id,
            clientID: registration?.client_id || null,
            expiresAt: expires,
        };
    });
}

/**
 * @param {string} pairingID Opaque ID
 * @param {string} token One-use secret
 * @param {object} db Connection
 * @returns {Promise<object>} Current authorized pairing
 */
async function pairing(pairingID, token, db = R.knex) {
    if (
        typeof pairingID !== "string" ||
        !/^[a-f0-9]{32}$/.test(pairingID) ||
        typeof token !== "string" ||
        !/^[a-zA-Z0-9_-]{43}$/.test(token)
    ) {
        throw problem("projectSignInInvalid");
    }
    const row = await db("project_oauth_pairing")
        .where({ id: pairingID })
        .whereNull("used_at")
        .where("expires_at", ">", Date.now())
        .first();
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(digest(token), "hex"))) {
        throw problem("projectSignInInvalid");
    }
    const scope = await permit(row.user_id, row.project_id, "admin", db);
    const config = await db("project_ai")
        .where({ project_id: row.project_id, revision: row.config_revision, mode: "subscription" })
        .first();
    if (!config || scope.revision !== row.project_revision) {
        throw problem("projectSignInInvalid");
    }
    return { row, scope, config };
}

/**
 * @param {string} pairingID Pairing
 * @param {string} token One-use credential
 * @param {object} response OAuth token response
 * @returns {Promise<object>} Stored and still unverified connection
 */
async function complete(pairingID, token, response) {
    const initial = await pairing(pairingID, token);
    const clientID = response?.client_id;
    if (
        typeof clientID !== "string" ||
        !/^[a-zA-Z0-9_-]{3,200}$/.test(clientID) ||
        clientID === "dynamic_agent_client" ||
        (initial.row.client_id && initial.row.client_id !== clientID)
    ) {
        throw problem("projectSignInInvalid");
    }
    const secret = await ai
        .client()
        .validateTokens(response, { clientID, nonce: initial.row.nonce, subject: initial.row.expected_subject });
    ai.cancelActive(initial.scope.id);
    return ai.locked(initial.scope.id, async () => {
        let previous;
        await R.knex.transaction(async (tx) => {
            const current = await pairing(pairingID, token, tx);
            if (current.config.secret_cipher) {
                previous = getVault().open(current.scope.id, current.config.secret_cipher);
            }
            await tx("project_ai")
                .where({ project_id: current.scope.id, revision: current.config.revision })
                .update({
                    secret_cipher: getVault().seal(current.scope.id, secret),
                    registration_json: JSON.stringify({
                        client_id: secret.client_id,
                        subject: secret.subject,
                        email: secret.email,
                    }),
                    state: "saved",
                    verified_at: null,
                    model: null,
                    models_json: null,
                    revision: current.config.revision + 1,
                    error_code: null,
                });
            const used = await tx("project_oauth_pairing")
                .where({ id: pairingID })
                .whereNull("used_at")
                .update({ used_at: Date.now() });
            if (!used) {
                throw problem("projectSignInInvalid");
            }
            await tx("project_ai_job")
                .where({ project_id: current.scope.id, status: "queued" })
                .update({ status: "cancelled", error_code: "changed", updated_at: Date.now() });
            await audit(tx, current.scope, "aiSignInStored");
        });
        let remoteRevoked = true;
        if (
            previous?.kind === "subscription" &&
            (previous.client_id !== secret.client_id || previous.subject !== secret.subject)
        ) {
            remoteRevoked = await ai.client().revoke(previous);
        }
        return { ok: true, remoteRevoked };
    });
}

/**
 * Local browser and server must be the same computer. Remote VMs use the supplied helper.
 * @param {number} userID Actor
 * @param {object} request Project/config
 * @param {Function} guard Guard
 * @param {string} base App origin
 * @param {string|null} callbackOrigin Explicit loopback origin published by local Docker
 * @returns {Promise<object>} Authorization URL, never tokens
 */
async function beginLocal(userID, request, guard, base, callbackOrigin = null) {
    if (process.env.UPTIME_KUMA_LOCAL_OAUTH !== "1") {
        throw problem("projectSignInNeedsHelper");
    }
    const config = await begin(userID, request, guard, base);
    listeners.get(request.projectID)?.close();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    let timer;
    let busy = false;
    let redirectURI;
    let listener;
    const handle = {
        close() {
            clearTimeout(timer);
            listener?.close();
            embeddedCallbacks.delete(state);
            if (listeners.get(request.projectID) === handle) {
                listeners.delete(request.projectID);
            }
        },
    };
    const accept = async (incoming, outgoing) => {
        outgoing.setHeader("Cache-Control", "no-store");
        outgoing.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        outgoing.setHeader("Referrer-Policy", "no-referrer");
        outgoing.setHeader("Content-Type", "text/plain; charset=utf-8");
        if (
            incoming.method !== "GET" ||
            incoming.headers.host !== new URL(redirectURI).host ||
            incoming.url.length > 10000
        ) {
            outgoing.writeHead(400).end("Invalid callback");
            return;
        }
        const callback = new URL(incoming.url, redirectURI);
        if (callback.pathname !== "/auth/callback") {
            outgoing.writeHead(404).end("Not found");
            return;
        }
        if (
            callback.searchParams.getAll("state").length !== 1 ||
            callback.searchParams.get("state") !== state ||
            busy
        ) {
            outgoing.writeHead(400).end("Invalid state");
            return;
        }
        busy = true;
        try {
            if (callback.searchParams.has("error")) {
                throw problem("projectSignInDeclined");
            }
            if (
                callback.searchParams.getAll("code").length !== 1 ||
                callback.searchParams.getAll("client_id").length > 1
            ) {
                throw problem("projectSignInInvalid");
            }
            const clientID = callback.searchParams.get("client_id") || config.clientID;
            if (config.clientID && clientID !== config.clientID) {
                throw problem("projectSignInInvalid");
            }
            await pairing(config.pairingID, config.token);
            const tokens = await ai.client().json("https://auth.openai.com/api/accounts/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: clientID || "",
                    code: callback.searchParams.get("code"),
                    code_verifier: verifier,
                    redirect_uri: redirectURI,
                    resource: "https://api.openai.com/v1",
                }).toString(),
            });
            const result = await complete(config.pairingID, config.token, { ...tokens, client_id: clientID });
            outgoing.end(
                result.remoteRevoked
                    ? "Подключение сохранено. Вернитесь в Uptime Kuma, выберите модель и выполните пробный запрос."
                    : "Новый вход сохранён. Отзыв прежнего входа не подтверждён; проверьте доступ приложения в настройках ChatGPT."
            );
        } catch {
            outgoing
                .writeHead(400)
                .end(
                    "Вход не подтверждён. Проверьте разрешение Uptime Kuma в настройках ChatGPT, затем начните заново. Пароли и токены здесь не показываются."
                );
        } finally {
            handle.close();
        }
    };
    if (callbackOrigin) {
        redirectURI = callbackOrigin + "/auth/callback";
        embeddedCallbacks.set(state, accept);
    } else {
        listener = http.createServer(accept);
        listener.headersTimeout = 10000;
        listener.requestTimeout = 15000;
        await new Promise((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", resolve);
        });
        redirectURI = "http://127.0.0.1:" + listener.address().port + "/auth/callback";
    }
    timer = setTimeout(handle.close, 600000);
    timer.unref();
    listeners.set(request.projectID, handle);
    return {
        authorizationURL: ai.client().authorizeURL({
            hostID: config.hostID,
            clientID: config.clientID,
            redirectURI,
            state,
            nonce: config.nonce,
            verifier,
        }),
        expiresAt: config.expiresAt,
    };
}

/** @returns {string|null} Explicit browser origin for the local Docker profile. */
function embeddedOrigin() {
    const candidate = process.env.UPTIME_KUMA_LOCAL_OAUTH_ORIGIN || "";
    if (process.env.UPTIME_KUMA_LOCAL_OAUTH !== "1" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(candidate)) {
        return null;
    }
    try {
        return new URL(candidate).origin === candidate ? candidate : null;
    } catch {
        return null;
    }
}

/**
 * @param {object} request Local browser callback
 * @param {object} response Non-cacheable status for this one sign-in
 * @returns {Promise<void>|void} Bounded callback result
 */
function embeddedCallback(request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    const origin = embeddedOrigin();
    if (!origin || request.method !== "GET" || request.headers.host !== new URL(origin).host ||
        request.url.length > 10000) {
        response.statusCode = 404;
        response.end("Not found");
        return;
    }
    const callback = new URL(request.url, origin);
    const state = callback.searchParams.get("state");
    const accept = callback.pathname === "/auth/callback" && embeddedCallbacks.get(state);
    if (!accept) {
        response.statusCode = 400;
        response.end("Invalid state");
        return;
    }
    return accept(request, response);
}

/** @returns {void} Close only our callback listeners */
function closeListeners() {
    for (const listener of listeners.values()) {
        listener.close();
    }
    listeners.clear();
}

module.exports = { begin, beginLocal, complete, pairing, closeListeners, transferOrigin, embeddedOrigin, embeddedCallback };
