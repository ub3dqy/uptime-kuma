const { createHash, timingSafeEqual } = require("node:crypto");

/**
 * Parse a trusted OpenSSH SHA256 host-key fingerprint.
 * @param {string} value Fingerprint confirmed outside the monitored connection.
 * @returns {Buffer} Expected digest.
 */
function parseSshHostFingerprint(value) {
    const fingerprint = typeof value === "string" ? value.trim() : "";
    if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) {
        throw new Error("A trusted SSH host key fingerprint in SHA256 format is required");
    }
    const encoded = fingerprint.slice(7).replace(/=$/, "");
    const digest = Buffer.from(encoded, "base64");
    if (digest.length !== 32 || digest.toString("base64").replace(/=$/, "") !== encoded) {
        throw new Error("Invalid SSH host key SHA256 fingerprint");
    }
    return digest;
}

/**
 * Build a verifier called by ssh2 before authentication.
 * @param {string} fingerprint Trusted host-key fingerprint.
 * @returns {function(Buffer): boolean} Host verifier.
 */
function sshHostVerifier(fingerprint) {
    const expected = parseSshHostFingerprint(fingerprint);
    return (key) => timingSafeEqual(createHash("sha256").update(key).digest(), expected);
}

module.exports = { parseSshHostFingerprint, sshHostVerifier };
