const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");

const fileName = ".setup-code";
const format = /^[A-Za-z0-9_-]{32}$/;

/**
 * @param {string} directory Private application data directory
 * @returns {string} Token owned by the person who installed the program
 * @throws {Error} The private code cannot be safely saved or read
 */
function readOrCreateSetupCode(directory) {
    const file = path.join(directory, fileName);
    const code = randomBytes(24).toString("base64url");
    try {
        fs.writeFileSync(file, code + "\n", { flag: "wx", mode: 0o600, flush: true });
        return code;
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }
    }
    const info = fs.lstatSync(file);
    if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== 33 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
        throw new Error("The installation code must be a private file in the data directory");
    }
    const opened = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const current = fs.fstatSync(opened);
        if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size) {
            throw new Error("The installation code file changed");
        }
        const saved = fs.readFileSync(opened, "utf8").trim();
        if (!format.test(saved)) {
            throw new Error("The installation code file has an invalid format");
        }
        return saved;
    } finally {
        fs.closeSync(opened);
    }
}

/**
 * @param {unknown} candidate Code supplied from the browser
 * @param {string|undefined} expected Private code for the current installation
 * @returns {boolean} Whether the code can authorize setup
 */
function matchesSetupCode(candidate, expected) {
    return (
        typeof candidate === "string" &&
        format.test(candidate) &&
        typeof expected === "string" &&
        format.test(expected) &&
        timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
    );
}

/**
 * @param {string} directory Application data directory
 * @returns {void}
 */
function removeSetupCode(directory) {
    fs.rmSync(path.join(directory, fileName), { force: true });
}

module.exports = { readOrCreateSetupCode, matchesSetupCode, removeSetupCode };
