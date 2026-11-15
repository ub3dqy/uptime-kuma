// Owned loopback fixtures only. Certificates and captured test messages stay outside Git.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const dgram = require("node:dgram");
const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
if (!folder || !fs.existsSync(path.join(folder, "fixture-cert.pem"))) {
    throw new Error("Missing owned TLS fixture");
}
const options = {
    key: fs.readFileSync(path.join(folder, "fixture-key.pem")),
    cert: fs.readFileSync(path.join(folder, "fixture-cert.pem")),
};
let messages = [];
const control = () => {
    try {
        return JSON.parse(fs.readFileSync(path.join(folder, "control.json"), "utf8"));
    } catch {
        return {};
    }
};
const respond = (request, response) => {
    if (request.url.startsWith("/redirect-private")) {
        response.writeHead(302, { Location: "http://127.0.0.2:" + request.socket.localPort + "/missing" });
        response.end();
        return;
    }
    if (request.url.startsWith("/health.json")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"status":"ready"}');
        return;
    }
    const state = control();
    const failing = request.url.startsWith("/missing") || (request.url.startsWith("/switch") && state.mode === "down");
    const send = () => {
        response.writeHead(failing ? 404 : 200, { "Content-Type": "text/plain" });
        response.end("Owned synthetic check");
    };
    if (request.url.startsWith("/slow")) {
        setTimeout(send, 150);
    } else {
        send();
    }
};
const web = http.createServer(respond);
const secure = https.createServer(options, respond);
const mail = tls.createServer(options, (socket) => {
    let buffer = "";
    let body = "";
    let dataMode = false;
    let recipient = "";
    socket.setTimeout(15000, () => socket.destroy());
    socket.on("error", () => {});
    socket.write("220 fixture.test ESMTP\r\n");
    socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length + body.length > 65536) {
            socket.destroy();
            return;
        }
        while (buffer.includes("\r\n")) {
            const index = buffer.indexOf("\r\n");
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (dataMode) {
                if (line === ".") {
                    dataMode = false;
                    messages.push({ recipient, body, at: Date.now() });
                    messages = messages.slice(-100);
                    fs.writeFileSync(path.join(folder, "messages.json"), JSON.stringify(messages));
                    socket.write("250 Message accepted by owned test inbox\r\n");
                    body = "";
                } else {
                    body += line + "\r\n";
                }
            } else if (/^EHLO|^HELO/i.test(line)) {
                socket.write("250-fixture.test\r\n250 AUTH PLAIN\r\n");
            } else if (/^AUTH PLAIN/i.test(line)) {
                socket.write("235 Authenticated synthetic account\r\n");
            } else if (/^MAIL FROM:/i.test(line)) {
                socket.write("250 Sender OK\r\n");
            } else if (/^RCPT TO:/i.test(line)) {
                recipient = line.replace(/^RCPT TO:\s*/i, "");
                socket.write(control().rejectMail ? "550 Synthetic recipient rejection\r\n" : "250 Recipient OK\r\n");
            } else if (/^DATA$/i.test(line)) {
                dataMode = true;
                socket.write("354 End with a dot\r\n");
            } else if (/^QUIT$/i.test(line)) {
                socket.end("221 Bye\r\n");
            } else if (/^RSET|^NOOP/i.test(line)) {
                socket.write("250 OK\r\n");
            } else {
                socket.write("500 Unsupported test command\r\n");
            }
        }
    });
});
const dns = dgram.createSocket("udp4");
dns.on("message", (query, remote) => {
    if (query.length < 17 || query.length > 512) {
        return;
    }
    let end = 12;
    while (end < query.length && query[end] > 0 && query[end] < 64) {
        end += query[end] + 1;
    }
    if (end + 5 > query.length) {
        return;
    }
    end += 5;
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
    dns.send(Buffer.concat([header, query.subarray(12, end), answer]), remote.port, remote.address);
});
Promise.all([web, secure, mail].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))))
    .then(() => new Promise((resolve) => dns.bind(0, "127.0.0.1", resolve)))
    .then(() => {
        fs.writeFileSync(path.join(folder, "messages.json"), "[]");
        fs.writeFileSync(
            path.join(folder, "fixture.json"),
            JSON.stringify({
                synthetic: true,
                http: `http://127.0.0.1:${web.address().port}`,
                https: `https://127.0.0.1:${secure.address().port}`,
                smtpPort: mail.address().port,
                dnsPort: dns.address().port,
            })
        );
        console.log("Owned HTTP/HTTPS/DNS/SMTP fixtures ready on loopback");
    });
