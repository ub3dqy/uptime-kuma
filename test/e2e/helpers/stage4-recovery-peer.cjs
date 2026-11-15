// Owned application reads one JSON configuration on every request. No system services are controlled.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const folder = process.env.KUMA_STAGE2_FIXTURE_DIR;
if (!folder || !/^private[\\/]e2e-workspace-[a-f0-9]{12}[\\/]peer$/.test(path.relative(process.cwd(), folder))) {
    throw new Error("Foreign recovery fixture refused");
}
const before = '{"broken":true,"password":"synthetic-application-secret"}\n';
const after = '{"broken":false,"password":"synthetic-application-secret"}\n';
const apps = {};
for (const id of ["first", "second"]) {
    const root = path.join(folder, "controlled-app-" + id);
    fs.mkdirSync(root, { mode: 0o700 });
    const file = path.join(root, "config.json");
    const baseline = path.join(root, "approved.json");
    fs.writeFileSync(file, before, { mode: 0o600 });
    fs.writeFileSync(baseline, after, { mode: 0o600 });
    apps[id] = {
        root,
        file,
        baseline,
        before,
        after,
        baselineSha256: crypto.createHash("sha256").update(after).digest("hex"),
    };
}
fs.writeFileSync(path.join(folder, "recovery-manifest.json"), JSON.stringify({ version: 1, targets: [] }), {
    mode: 0o600,
});
const control = path.join(folder, "recovery-control.json");
fs.writeFileSync(control, JSON.stringify({ first: false, second: false }));
let requests = 0;
const server = http.createServer((request, response) => {
    requests++;
    try {
        const id = request.url === "/health/first" ? "first" : request.url === "/health/second" ? "second" : null;
        if (!id) {
            response.writeHead(404).end();
            return;
        }
        const config = JSON.parse(fs.readFileSync(apps[id].file, "utf8"));
        const settings = JSON.parse(fs.readFileSync(control, "utf8"));
        const broken = config.broken === true || settings[id] === true;
        response.writeHead(broken ? 503 : 200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end(broken ? "Synthetic application is unavailable" : "Synthetic application is healthy");
        fs.writeFileSync(
            path.join(folder, "recovery-requests.json"),
            JSON.stringify({ requests, broken, at: Date.now() })
        );
    } catch {
        response.writeHead(503).end("Synthetic configuration cannot be read");
    }
});
server.listen(0, "127.0.0.1", () => {
    for (const [id, app] of Object.entries(apps)) {
        app.url = "http://127.0.0.1:" + server.address().port + "/health/" + id;
    }
    fs.writeFileSync(path.join(folder, "recovery-fixture.json"), JSON.stringify({ synthetic: true, apps }));
    console.log("Owned configuration-recovery application ready on loopback");
});
process.once("SIGTERM", () => server.close());
