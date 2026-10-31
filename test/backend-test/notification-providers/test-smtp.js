const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const SMTP = require("../../../server/notification-providers/smtp");
const { SMTPMonitorType } = require("../../../server/monitor-types/smtp");
const { UP } = require("../../../src/util");

/**
 * A loopback SMTP peer that records mail without delivering it.
 * @param {TestContext} context Test lifecycle
 * @returns {Promise<object>} Listener and captured requests
 */
async function localSmtp(context) {
    const sockets = new Set();
    const received = { recipients: [], messages: [], authenticated: false };
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.setEncoding("utf8");
        let buffer = "";
        let message;
        socket.write("220 loopback SMTP test\r\n");
        socket.on("data", (chunk) => {
            buffer += chunk;
            while (buffer.includes("\r\n")) {
                const end = buffer.indexOf("\r\n");
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (message) {
                    if (line === ".") {
                        received.messages.push(message.join("\r\n"));
                        message = undefined;
                        socket.write("250 stored locally\r\n");
                    } else {
                        message.push(line);
                    }
                } else if (/^EHLO|^HELO/.test(line)) {
                    socket.write("250-loopback\r\n250-AUTH PLAIN\r\n250 SIZE 1048576\r\n");
                } else if (line.startsWith("AUTH PLAIN ")) {
                    const auth = Buffer.from(line.slice(11), "base64").toString();
                    received.authenticated = auth === "\0test-user\0test-password";
                    socket.write(received.authenticated ? "235 authenticated\r\n" : "535 bad test credentials\r\n");
                } else if (line === "STARTTLS") {
                    socket.write("454 TLS unavailable in this plain-text test peer\r\n");
                } else if (line.startsWith("RCPT TO:")) {
                    received.recipients.push(line.slice(8));
                    socket.write("250 recipient accepted\r\n");
                } else if (line === "DATA") {
                    message = [];
                    socket.write("354 send message\r\n");
                } else if (line === "QUIT") {
                    socket.end("221 goodbye\r\n");
                } else {
                    socket.write("250 OK\r\n");
                }
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    context.after(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise((resolve) => server.close(resolve));
    });
    return { port: server.address().port, received };
}

describe("SMTP dependency compatibility", () => {
    test("SMTP provider preserves authentication, recipients, headers and templated HTML", async (context) => {
        const { port, received } = await localSmtp(context);
        const result = await new SMTP().send(
            {
                smtpHost: "127.0.0.1",
                smtpPort: port,
                smtpSecure: false,
                disableStartTLS: true,
                smtpUsername: "test-user",
                smtpPassword: "test-password",
                smtpFrom: "sender@example.invalid",
                smtpTo: "owner@example.invalid",
                smtpCC: "copy@example.invalid",
                smtpBCC: "blind@example.invalid",
                smtpAdditionalHeaders: '{"X-Kuma-Test":"local-only"}',
                customSubject: "Check {{ name }}",
                customBody: "<b>{{ msg }}</b>",
                htmlBody: true,
            },
            "Testing",
            { name: "Customer", url: "https://example.invalid", type: "http" },
            { status: 1 }
        );
        assert.equal(result, "Sent Successfully.");
        assert.equal(received.authenticated, true);
        assert.deepEqual(received.recipients.sort(), [
            "<blind@example.invalid>",
            "<copy@example.invalid>",
            "<owner@example.invalid>",
        ]);
        assert.equal(received.messages.length, 1);
        assert.match(received.messages[0], /Subject: Check Customer/);
        assert.match(received.messages[0], /X-Kuma-Test: local-only/i);
        assert.match(received.messages[0], /Content-Type: text\/html/i);
        assert.ok(received.messages[0].includes("<b>Testing</b>"));
        assert.ok(!received.messages[0].includes("Bcc:"));
    });

    test("SMTP monitor verifies ordinary connections and refuses required STARTTLS when absent", async (context) => {
        const { port } = await localSmtp(context);
        const monitor = new SMTPMonitorType();
        const heartbeat = {};
        await monitor.check({ hostname: "127.0.0.1", port, smtpSecurity: "nostarttls" }, heartbeat);
        assert.equal(heartbeat.status, UP);
        await assert.rejects(monitor.check({ hostname: "127.0.0.1", port, smtpSecurity: "starttls" }, {}));
    });
});
