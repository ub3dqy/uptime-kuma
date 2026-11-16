const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const witness = require("../../server/independent-witness");
const { fixture } = require("../fixtures/project-workspace.cjs");
const config = {
    nodeID: "synthetic-witness",
    secret: Buffer.alloc(32, 42).toString("base64url"),
    hash: "synthetic-configuration-fingerprint",
};
/** @returns {object} One fresh authenticated synthetic request. */
function request() {
    const value = {
        nodeID: config.nodeID,
        timestamp: Date.now(),
        nonce: crypto.randomBytes(32).toString("base64url"),
        channels: ["email", "telegram"],
    };
    return { ...value, signature: witness.sign(config, witness.requestText(value)) };
}
test("witness requests bind identity, nonce, time and channels; arbitrary web responses cannot prove readiness", () => {
    const value = request();
    assert.equal(witness.valid(value, config), true);
    for (const changed of [
        { nodeID: "another-witness" },
        { timestamp: value.timestamp - 90000 },
        { channels: [] },
        { nonce: crypto.randomBytes(32).toString("base64url") },
        { signature: "0".repeat(64) },
        { unexpected: true },
    ]) {
        assert.equal(witness.valid({ ...value, ...changed }, config), false);
    }
    assert.equal(witness.valid(value, null), false);
});
test("signed database readiness is replay-protected across handler instances and exposes no project information", async (t) => {
    const { db, ids } = await fixture(t);
    const value = request();
    const answer = await witness.accept(value, config, db);
    assert.equal(answer.ready, true);
    assert.equal(answer.nonce, value.nonce);
    assert.equal(
        answer.signature,
        witness.sign(
            config,
            ["uptime-kuma-witness/response/v1", witness.requestText(value), answer.timestamp, "ready=1"].join("\n")
        )
    );
    assert.equal(JSON.stringify(answer).includes(config.secret), false);
    await assert.rejects(witness.accept(value, config, db));
    assert.equal((await db("witness_state").first()).channels, "email,telegram");
    await assert.rejects(witness.status(ids.viewer), /projectAccessDenied/);
    await assert.rejects(witness.status(ids.admin), /projectAccessDenied/);
});
