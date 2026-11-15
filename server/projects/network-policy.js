const dns = require("node:dns");
const net = require("node:net");
const { R } = require("redbean-node");
const forbidden = new net.BlockList();
for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
]) {
    forbidden.addSubnet(address, prefix);
}

/** @param {string[]} allowed Explicit installation-admin approved IPv4 targets */
class ProjectNetworkPolicy {
    /**
     * @param {string[]} allowed Explicitly approved targets
     */
    constructor(allowed = []) {
        this.allowed = new Set(allowed);
    }
    /**
     * @param {string} address Actual address
     * @returns {boolean} Permitted public or explicitly selected address
     */
    permits(address) {
        return net.isIP(address) === 4 && (this.allowed.has(address) || !forbidden.check(address, "ipv4"));
    }
    /**
     * @param {string} host Literal target
     * @returns {void} Refuse forbidden literal redirects as well as initial URLs
     * @throws {Error} Invalid value or unavailable protected data
     */
    checkLiteral(host) {
        const target = host.startsWith("[") ? host.slice(1, -1) : host;
        if (net.isIP(target) && !this.permits(target)) {
            throw new Error("PROJECT_TARGET_BLOCKED");
        }
    }
    /**
     * @param {string} host Target
     * @returns {Promise<string[]>} Actual pinned permitted addresses
     */
    async addresses(host) {
        const target = host.startsWith("[") ? host.slice(1, -1) : host;
        if (net.isIP(target)) {
            if (!this.permits(target)) {
                throw new Error("PROJECT_TARGET_BLOCKED");
            }
            return [target];
        }
        let timer;
        const records = await Promise.race([
            dns.promises.lookup(target, { family: 4, all: true }),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("ETIMEDOUT")), 10000);
            }),
        ]).finally(() => clearTimeout(timer));
        const addresses = records.map((entry) => entry.address).filter((address) => this.permits(address));
        if (!addresses.length) {
            throw new Error("PROJECT_TARGET_BLOCKED");
        }
        return addresses;
    }
    /**
     * @param {string} host Host
     * @param {object|number} options Node lookup options
     * @param {Function} callback Node callback
     * @returns {void} Pinned connection-time lookup
     */
    lookup(host, options, callback) {
        this.addresses(host)
            .then((addresses) =>
                callback(
                    null,
                    options?.all ? addresses.map((address) => ({ address, family: 4 })) : addresses[0],
                    options?.all ? undefined : 4
                )
            )
            .catch(callback);
    }
}

/**
 * @param {number} ownerID Monitor data owner
 * @returns {Promise<ProjectNetworkPolicy|null>} New workspace policy, legacy owners preserved
 */
async function policyForOwner(ownerID) {
    if (!Number.isSafeInteger(ownerID)) {
        return null;
    }
    const project = await R.knex("project").where({ data_user_id: ownerID, personal: 0 }).first();
    return project ? new ProjectNetworkPolicy(JSON.parse(project.allowed_ips_json)) : null;
}
/**
 * @param {number} projectID Exact project
 * @returns {Promise<ProjectNetworkPolicy>} Policy for new protected channels
 */
async function policyForProject(projectID) {
    const project = await R.knex("project").where({ id: projectID }).first();
    if (!project) {
        throw new Error("PROJECT_TARGET_BLOCKED");
    }
    return new ProjectNetworkPolicy(JSON.parse(project.allowed_ips_json));
}

module.exports = { ProjectNetworkPolicy, policyForOwner, policyForProject };
