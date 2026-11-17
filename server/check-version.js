const { setSetting, setting } = require("./util-server");
const axios = require("axios");
const { compareVersions, validate } = require("compare-versions");
const { log } = require("../src/util");

exports.version = require("../package.json").version;
exports.latestVersion = null;
const releasesURL = "https://api.github.com/repos/ub3dqy/uptime-kuma/releases?per_page=20";
const checkInterval = 48 * 60 * 60 * 1000;
let interval;

exports.startInterval = () => {
    clearInterval(interval);
    const check = async () => {
        if ((await setting("checkUpdate")) === false) {
            return;
        }
        try {
            if (process.env.TEST_CHECK_VERSION === "1") {
                exports.latestVersion = "1000.0.0";
                return;
            }
            const { data } = await axios.get(releasesURL, {
                timeout: 5000,
                maxRedirects: 0,
                maxContentLength: 512 * 1024,
                headers: { Accept: "application/vnd.github+json" },
            });
            const includePreview = Boolean(await setting("checkBeta"));
            if (!Array.isArray(data)) {
                return;
            }
            const versions = data
                .filter((release) => !release?.draft && (includePreview || !release?.prerelease))
                .map((release) => typeof release?.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "")
                .filter((version) => validate(version))
                .sort((a, b) => compareVersions(b, a));
            exports.latestVersion = versions[0] || null;
        } catch {
            log.info("update-checker", "Could not check the ub3dqy release list");
        }
    };
    check();
    interval = setInterval(check, checkInterval);
};

/**
 * @param {boolean} value Whether to check the ub3dqy release list
 * @returns {Promise<void>} Saved update preference
 */
exports.enableCheckUpdate = async (value) => {
    await setSetting("checkUpdate", value);
    clearInterval(interval);
    if (value) {
        exports.startInterval();
    }
};

exports.socket = null;
