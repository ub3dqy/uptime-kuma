const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("dgram");
const radius = require("radius");
const { radius: radiusCheck } = require("../../server/util-server");
const RadiusClient = require("../../server/radius-client");

/**
 * Start a UDP RADIUS server that replies to every Access-Request with the given response code.
 * @param {string} secret RADIUS shared secret
 * @param {string} responseCode RADIUS response code to send back
 * @returns {Promise<{socket: import("dgram").Socket, port: number, address: string}>} The bound UDP socket and its address
 */
function startRadiusServer(secret, responseCode) {
    const socket = dgram.createSocket("udp4");

    socket.on("message", (msg, rinfo) => {
        try {
            const request = radius.decode({ packet: msg, secret });
            const response = radius.encode_response({
                packet: request,
                code: responseCode,
                secret,
            });
            socket.send(response, 0, response.length, rinfo.port, rinfo.address, () => {});
        } catch (error) {
            // Ignore decode errors, the client will time out
        }
    });

    return new Promise((resolve) => {
        socket.on("listening", () => {
            const { address, port } = socket.address();
            resolve({ socket, port, address });
        });
        socket.bind(0, "127.0.0.1");
    });
}

describe("RadiusMonitorType", () => {
    const secret = "testing123";

    test("radius() resolves with code Access-Challenge when server responds with Access-Challenge", async () => {
        const { socket, port } = await startRadiusServer(secret, "Access-Challenge");

        try {
            const resp = await radiusCheck("127.0.0.1", "bob", "testpw", "called", "calling", secret, port, 2000);
            assert.strictEqual(resp.code, "Access-Challenge");
        } finally {
            socket.close();
        }
    });

    test("radius() rejects when server responds with Access-Reject", async () => {
        const { socket, port } = await startRadiusServer(secret, "Access-Reject");

        try {
            await assert.rejects(
                radiusCheck("127.0.0.1", "bob", "testpw", "called", "calling", secret, port, 2000),
                /RADIUS Access-Reject from 127\.0\.0\.1:/
            );
        } finally {
            socket.close();
        }
    });

    test("radius() resolves with code Access-Accept when server responds with Access-Accept", async () => {
        const { socket, port } = await startRadiusServer(secret, "Access-Accept");

        try {
            const resp = await radiusCheck("127.0.0.1", "bob", "testpw", "called", "calling", secret, port, 2000);
            assert.strictEqual(resp.code, "Access-Accept");
        } finally {
            socket.close();
        }
    });
});

for (const invalid of ["secret", "identifier", "sender", "malformed"]) {
    test(`RADIUS ignores a ${invalid} mismatch before the authentic reply`, async (context) => {
        const secret = "local-test-secret";
        const peer = dgram.createSocket("udp4");
        const other = dgram.createSocket("udp4");
        await new Promise((resolve) => peer.bind(0, "127.0.0.1", resolve));
        await new Promise((resolve) => other.bind(0, "127.0.0.1", resolve));
        context.after(() => {
            peer.close();
            other.close();
        });
        peer.on("message", (packet, info) => {
            const request = radius.decode({ packet, secret });
            const good = radius.encode_response({ packet: request, code: "Access-Accept", secret });
            let bad = radius.encode_response({
                packet: invalid === "identifier" ? { ...request, identifier: (request.identifier + 1) % 256 } : request,
                code: "Access-Reject",
                secret: invalid === "secret" ? "different-local-secret" : secret,
            });
            if (invalid === "malformed") {
                bad = Buffer.from([2, request.identifier, 0, 1]);
            }
            (invalid === "sender" ? other : peer).send(bad, info.port, info.address);
            setTimeout(() => peer.send(good, info.port, info.address), 20);
        });
        const client = new RadiusClient({ host: "127.0.0.1", hostPort: peer.address().port, timeout: 500 });
        assert.equal(
            (await client.accessRequest({ secret, attributes: [["User-Name", "local-test"]] })).code,
            "Access-Accept"
        );
    });
}

for (const invalid of ["wrong-secret", "missing-message-authenticator"]) {
    test(`RADIUS refuses Access-Accept with ${invalid}`, async (context) => {
        const secret = "local-test-secret";
        const peer = dgram.createSocket("udp4");
        await new Promise((resolve) => peer.bind(0, "127.0.0.1", resolve));
        context.after(() => peer.close());
        peer.on("message", (packet, info) => {
            const request = radius.decode({ packet, secret });
            const response = radius.encode_response({
                packet: invalid === "missing-message-authenticator" ? { ...request, attributes: {} } : request,
                code: "Access-Accept",
                secret: invalid === "wrong-secret" ? "different-local-secret" : secret,
            });
            peer.send(response, info.port, info.address);
        });
        const client = new RadiusClient({ host: "127.0.0.1", hostPort: peer.address().port, timeout: 25, retries: 1 });
        await assert.rejects(client.accessRequest({ secret, attributes: [["User-Name", "local-test"]] }), /timeout/);
    });
}
