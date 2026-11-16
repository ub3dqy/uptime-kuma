const { createHash } = require("node:crypto");
const { R } = require("redbean-node");
const { checkStatusCode } = require("./util-server");

const maxSites = 8;
const freshFor = 6 * 60_000;

/**
 * @param {object[]} sites Signed results in numeric monitor order
 * @returns {string} Closed canonical format shared with the witness
 */
function sitesText(sites) {
    return sites
        .map(({ id, hash, checkedAt, httpStatus, responseMS }) =>
            [id, hash, checkedAt, httpStatus ?? "-", responseMS ?? "-"].join(":")
        )
        .join(",");
}

/**
 * @param {unknown} sites Results sent by the remote node
 * @param {number} timestamp Signed request time
 * @returns {boolean} Valid, bounded, uniquely ordered results
 */
function validSites(sites, timestamp) {
    if (!Array.isArray(sites) || !sites.length || sites.length > maxSites) {
        return false;
    }
    let previousID = 0;
    return sites.every((item) => {
        if (
            item === null ||
            typeof item !== "object" ||
            Object.keys(item).sort().join(",") !== "checkedAt,hash,httpStatus,id,responseMS" ||
            !Number.isSafeInteger(item.id) ||
            item.id <= previousID ||
            typeof item.hash !== "string" ||
            !/^[a-f0-9]{64}$/.test(item.hash) ||
            !Number.isSafeInteger(item.checkedAt) ||
            item.checkedAt > timestamp ||
            item.checkedAt < timestamp - 30_000
        ) {
            return false;
        }
        previousID = item.id;
        if (item.httpStatus === null) {
            return item.responseMS === null;
        }
        return (
            Number.isSafeInteger(item.httpStatus) &&
            item.httpStatus >= 100 &&
            item.httpStatus <= 599 &&
            Number.isSafeInteger(item.responseMS) &&
            item.responseMS >= 0 &&
            item.responseMS <= 30_000
        );
    });
}

/**
 * @param {string} url Exact address configured for that monitor
 * @returns {string} Hash without exposing the address to result readers
 */
function targetHash(url) {
    return createHash("sha256").update(url).digest("hex");
}

/**
 * @param {object} tx Current signed-request transaction
 * @param {object} config Verified witness configuration
 * @param {object[]} sites Signed measurements
 * @returns {Promise<void>} Store latest results only for matching opted-in HTTP monitors
 */
async function retainSites(tx, config, sites) {
    if (!sites) {
        return;
    }
    for (const result of sites) {
        const monitor = await tx("monitor")
            .where({ id: result.id, type: "http", active: 1, witness_site: 1 })
            .forUpdate()
            .first("url");
        if (!monitor?.url || targetHash(monitor.url) !== result.hash) {
            continue;
        }
        const previous = await tx("witness_site_result").where({ monitor_id: result.id }).first();
        if (
            previous?.config_hash === config.hash &&
            previous?.target_hash === result.hash &&
            Number(previous.checked_at) >= result.checkedAt
        ) {
            continue;
        }
        await tx("witness_site_result")
            .insert({
                monitor_id: result.id,
                node_id: config.nodeID,
                config_hash: config.hash,
                target_hash: result.hash,
                checked_at: result.checkedAt,
                http_status: result.httpStatus,
                response_ms: result.responseMS,
            })
            .onConflict("monitor_id")
            .merge();
    }
}

/**
 * @param {object} monitor Caller-authorized monitor
 * @param {object|null} config Current witness identity
 * @returns {Promise<object|null>} Current independent observation, including validity of its age
 */
async function siteResult(monitor, config) {
    if (monitor.type !== "http" || !monitor.witness_site || !monitor.url) {
        return null;
    }
    const row =
        config &&
        (await R.knex("witness_site_result")
            .where({
                monitor_id: monitor.id,
                node_id: config.nodeID,
                config_hash: config.hash,
                target_hash: targetHash(monitor.url),
            })
            .first());
    const result = { label: config?.label || "", checkedAt: row ? Number(row.checked_at) : null };
    if (!row) {
        return { ...result, state: "missing" };
    }
    if (Date.now() - result.checkedAt > freshFor) {
        return { ...result, state: "stale" };
    }
    const success =
        row.http_status !== null &&
        checkStatusCode(row.http_status, JSON.parse(monitor.accepted_statuscodes_json || '["200-299"]'));
    return {
        ...result,
        state: success ? "up" : "down",
        httpStatus: row.http_status,
        responseMS: row.response_ms,
    };
}

module.exports = { sitesText, validSites, retainSites, siteResult, targetHash };
