const { R } = require("redbean-node");

/**
 * @param {object|string} notification Stored channel or JSON
 * @returns {object} Server-only decoded settings
 * @throws {Error} Invalid value or unavailable protected data
 */
function readNotificationConfig(notification) {
    const config = JSON.parse(typeof notification === "string" ? notification : notification.config);
    if (config?.projectEncryption) {
        const { projectID, cipher } = config.projectEncryption;
        const { __dataOwnerID, ...settings } = require("./projects/vault")
            .getVault()
            .open(projectID, cipher, "notification");
        if (
            typeof notification === "string" ||
            !Number.isSafeInteger(__dataOwnerID) ||
            notification.user_id !== __dataOwnerID
        ) {
            throw require("./projects/access").problem("projectKeyMissing");
        }
        return settings;
    }
    return config;
}

/**
 * @param {object} config Settings
 * @param {number} ownerID Data owner
 * @param {string|null} previous Prior record
 * @param {object} db Transaction
 * @param {number|null} explicitProjectID Project selected by the closed API
 * @returns {Promise<object>} Settings protected for project data owners
 */
async function protectNotificationConfig(config, ownerID, previous = null, db = R.knex, explicitProjectID = null) {
    let projectID;
    if (previous) {
        const envelope = JSON.parse(previous);
        projectID = envelope?.projectEncryption?.projectID;
    }
    if (!projectID && (await db.schema.hasTable("project"))) {
        const query = db("project").where({ data_user_id: ownerID });
        if (explicitProjectID !== null) {
            query.where({ id: explicitProjectID });
        }
        const project = await query.first();
        projectID = project?.id;
    }
    if (!projectID && (await db.schema.hasTable("project"))) {
        throw require("./projects/access").problem("projectKeyMissing");
    }
    if (!projectID) {
        return config;
    }
    return {
        managedDelivery: config.managedDelivery === true,
        type: config.type,
        name: config.name,
        projectEncryption: {
            projectID,
            cipher: require("./projects/vault")
                .getVault()
                .seal(projectID, { ...config, __dataOwnerID: ownerID }, "notification"),
        },
    };
}

module.exports = { readNotificationConfig, protectNotificationConfig };
