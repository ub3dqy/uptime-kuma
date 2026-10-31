const { utils } = require("ssh2");

/**
 * Generate parseable Ed25519 keys only for isolated test peers.
 * ssh2 1.17's generator sometimes strips a leading zero from the fixed-length
 * public key. Reject that malformed fixture; keep normal key parsing unchanged.
 * @returns {{private: string, public: string}} A valid test key pair.
 */
function generateEd25519KeyPair() {
    for (let attempt = 0; attempt < 8; attempt++) {
        const pair = utils.generateKeyPairSync("ed25519");
        if (!(utils.parseKey(pair.private) instanceof Error)) {
            return pair;
        }
    }
    throw new Error("Unable to generate a valid Ed25519 test key pair");
}

module.exports = { generateEd25519KeyPair };
