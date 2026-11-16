const { R } = require("redbean-node");
const { savedSteps, journeyResult } = require("./monitor-types/browser-journey");
const { siteResult } = require("./witness-sites");
const { configuration } = require("./independent-witness");
const { currentServiceState, observationTime } = require("../src/overview-state.ts");
const { parentIsInactive } = require("./projects/store");

/**
 * @param {number} ownerID Authorized owner of this monitor
 * @param {number} monitorID Requested monitor
 * @param {boolean} includeImage Whether the screenshot was requested
 * @returns {Promise<object>} Latest protected browser evidence and independent observation
 */
async function readVerification(ownerID, monitorID, includeImage = false) {
    if (!Number.isSafeInteger(monitorID) || monitorID < 1) {
        throw new Error("verificationUnavailable");
    }
    const monitor = await R.knex("monitor").where({ id: monitorID, user_id: ownerID }).first();
    if (!monitor) {
        throw new Error("verificationUnavailable");
    }
    const journey = savedSteps(monitor).length ? await journeyResult(monitor, includeImage) : null;
    if (monitor.type !== "http" || !monitor.witness_site) {
        return { journey, comparison: null };
    }
    if (monitor.parent) {
        const ancestors = await R.knex("monitor").where({ user_id: ownerID }).select("id", "active", "parent");
        monitor.forceInactive = parentIsInactive(monitor, new Map(ancestors.map((item) => [item.id, item])));
    }
    const beat = await R.knex("heartbeat")
        .where({ monitor_id: monitorID })
        .orderBy("time", "desc")
        .orderBy("id", "desc")
        .first();
    const status = currentServiceState(monitor, beat ? [beat] : [], Date.now()).state;
    return {
        journey,
        comparison: {
            primary: { state: status, checkedAt: observationTime(beat?.time), responseMS: beat?.ping ?? null },
            secondary: await siteResult(monitor, configuration()),
        },
    };
}

module.exports = { readVerification };
