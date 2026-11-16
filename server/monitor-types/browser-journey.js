const axios = require("axios");
const http = require("node:http");
const https = require("node:https");
const { createHash } = require("node:crypto");
const { R } = require("redbean-node");
const { ProjectNetworkPolicy, policyForOwner } = require("../projects/network-policy");

const maxSteps = 8;
const maxResponse = 4 * 1024 * 1024;
const maxPageBytes = 16 * 1024 * 1024;

/**
 * @param {unknown} value Steps received from the monitor form
 * @returns {object[]} Bounded read-only actions by exact visible text
 * @throws {Error} Unsupported, empty or excessively long step
 */
function stepsFrom(value) {
    if (!Array.isArray(value) || value.length > maxSteps) {
        throw new Error("browserJourneyInvalid");
    }
    return value.map((step) => {
        if (
            !step ||
            typeof step !== "object" ||
            Object.keys(step).sort().join(",") !== "action,text" ||
            !["click", "visible"].includes(step.action) ||
            typeof step.text !== "string" ||
            !step.text.trim() ||
            step.text.length > 120 ||
            /[\u0000-\u001f\u007f]/.test(step.text)
        ) {
            throw new Error("browserJourneyInvalid");
        }
        return { action: step.action, text: step.text.trim() };
    });
}

/**
 * @param {object} monitor Saved browser monitor
 * @returns {object[]} Validated saved actions
 */
function savedSteps(monitor) {
    return monitor.type === "real-browser" && monitor.browser_steps_json
        ? stepsFrom(JSON.parse(monitor.browser_steps_json))
        : [];
}

/**
 * @param {object} monitor Saved configuration
 * @returns {string} Identifier binding evidence to the exact URL and actions
 */
function configuration(monitor) {
    return createHash("sha256")
        .update(JSON.stringify([monitor.url, savedSteps(monitor)]))
        .digest("hex");
}

/**
 * @param {string} url Address configured in the monitor
 * @returns {URL} The original site to which the actions are confined
 * @throws {Error} Invalid or credential-bearing address
 */
function journeyTarget(url) {
    try {
        const target = new URL(url);
        if (["http:", "https:"].includes(target.protocol) && !target.username && !target.password && !target.hash) {
            return target;
        }
    } catch {
        // The form displays a fixed validation error.
    }
    throw new Error("browserJourneyInvalid");
}

/**
 * @param {object} browser Local Playwright browser
 * @param {object} monitor Target and interval
 * @param {object} policy Project addresses permitted by the installation
 * @returns {Promise<object>} Timed test result and optional protected screenshot
 */
async function runJourney(browser, monitor, policy) {
    const target = journeyTarget(monitor.url);
    policy.checkLiteral(target.hostname);
    const steps = savedSteps(monitor);
    const timeout = Math.min(30_000, monitor.interval * 800);
    const abort = new AbortController();
    const deadline = Date.now() + timeout;
    const timer = setTimeout(() => abort.abort(), timeout);
    const lookup = policy.lookup.bind(policy);
    const httpAgent = new http.Agent({ lookup, maxSockets: 4 });
    const httpsAgent = new https.Agent({ lookup, maxSockets: 4 });
    // Browser traffic that bypasses interception has a closed loopback proxy and no loopback exception.
    let context;
    let page;
    let failedStep = 0;
    let received = 0;
    let requests = 0;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
        context = await browser.newContext({
            viewport: { width: 960, height: 600 },
            serviceWorkers: "block",
            acceptDownloads: false,
            proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
        });
        await context.routeWebSocket("**/*", (socket) => socket.close({ code: 1008 }));
        await context.addInitScript(() => {
            // Prevent page scripts from opening direct UDP connections outside the private browser context.
            for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
                Object.defineProperty(globalThis, name, { value: undefined, configurable: false });
            }
        });
        await context.route("**/*", async (route) => {
            try {
                const request = route.request();
                const dest = new URL(request.url());
                if (
                    ++requests > 96 ||
                    abort.signal.aborted ||
                    dest.origin !== target.origin ||
                    dest.username ||
                    dest.password ||
                    !["GET", "HEAD"].includes(request.method())
                ) {
                    await route.abort("blockedbyclient");
                    return;
                }
                policy.checkLiteral(dest.hostname);
                const original = await request.allHeaders();
                const headers = Object.fromEntries(
                    Object.entries(original).filter(([key]) =>
                        /^(accept|accept-language|user-agent|cookie|referer|sec-fetch-.*)$/i.test(key)
                    )
                );
                const reply = await axios.request({
                    url: dest.href,
                    method: request.method(),
                    headers,
                    httpAgent,
                    httpsAgent,
                    proxy: false,
                    maxRedirects: 0,
                    maxContentLength: maxResponse,
                    responseType: "arraybuffer",
                    validateStatus: () => true,
                    timeout: remaining(),
                    signal: abort.signal,
                });
                if ((reply.status >= 300 && reply.status < 400) || received + reply.data.byteLength > maxPageBytes) {
                    await route.abort("blockedbyclient");
                    return;
                }
                received += reply.data.byteLength;
                const outgoing = Object.fromEntries(
                    Object.entries(reply.headers).filter(
                        ([key]) =>
                            !/^(connection|content-encoding|content-length|transfer-encoding|refresh|alt-svc)$/i.test(
                                key
                            )
                    )
                );
                await route.fulfill({ status: reply.status, headers: outgoing, body: Buffer.from(reply.data) });
            } catch {
                await route.abort("failed").catch(() => {});
            }
        });
        page = await context.newPage();
        const start = Date.now();
        const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: remaining() });
        if (!response?.ok()) {
            throw new Error("page unavailable");
        }
        for (const [index, step] of steps.entries()) {
            failedStep = index + 1;
            abort.signal.throwIfAborted();
            const element = page.getByText(step.text, { exact: true });
            if (step.action === "click") {
                await element.click({ timeout: remaining() });
            } else {
                await element.waitFor({ state: "visible", timeout: remaining() });
            }
            if (new URL(page.url()).origin !== target.origin) {
                throw new Error("unexpected page");
            }
        }
        return { failedStep: null, responseMS: Date.now() - start, screenshot: null };
    } catch {
        const screenshot = await page?.screenshot({ type: "jpeg", quality: 50, timeout: 2000 }).catch(() => null);
        return { failedStep, screenshot: screenshot?.length <= 240_000 ? screenshot.toString("base64") : null };
    } finally {
        clearTimeout(timer);
        abort.abort();
        httpAgent.destroy();
        httpsAgent.destroy();
        await context?.close();
    }
}

/**
 * @param {object} browser Local Playwright browser
 * @param {object} monitor Owned check
 * @returns {Promise<object>} Result retained for the current monitor configuration only
 */
async function checkJourney(browser, monitor) {
    const version = configuration(monitor);
    const checkedAt = Date.now();
    const policy = (await policyForOwner(monitor.user_id)) || new ProjectNetworkPolicy();
    const outcome = await runJourney(browser, monitor, policy);
    await R.knex.transaction(async (tx) => {
        const current = await tx("monitor")
            .where({ id: monitor.id, user_id: monitor.user_id, active: 1 })
            .forUpdate()
            .first();
        if (!current || configuration(current) !== version) {
            return;
        }
        const retained = await tx("browser_journey_result").where({ monitor_id: monitor.id }).first("checked_at");
        if (retained && Number(retained.checked_at) > checkedAt) {
            return;
        }
        await tx("browser_journey_result")
            .insert({
                monitor_id: monitor.id,
                configuration: version,
                checked_at: checkedAt,
                failed_step: outcome.failedStep,
                screenshot: outcome.screenshot,
            })
            .onConflict("monitor_id")
            .merge();
    });
    return outcome;
}

/**
 * @param {object} monitor Owned monitor already checked by the caller
 * @param {boolean} includeImage Whether the user opened the failure screenshot
 * @returns {Promise<object|null>} The latest private browser evidence for those actions
 */
async function journeyResult(monitor, includeImage) {
    const steps = savedSteps(monitor);
    if (!steps.length) {
        return null;
    }
    const row = await R.knex("browser_journey_result")
        .where({ monitor_id: monitor.id, configuration: configuration(monitor) })
        .first();
    return row
        ? {
              checkedAt: Number(row.checked_at),
              failedStep: row.failed_step,
              steps: steps.length,
              action: row.failed_step > 0 ? steps[row.failed_step - 1]?.text : null,
              hasScreenshot: Boolean(row.screenshot),
              screenshot: includeImage ? row.screenshot : null,
          }
        : { checkedAt: null, steps: steps.length };
}

module.exports = { stepsFrom, savedSteps, journeyTarget, checkJourney, journeyResult, runJourney };
