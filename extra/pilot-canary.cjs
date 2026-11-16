const http = require("node:http");

// A private, synthetic peer. It never calls other services or sends notifications.
const server = http.createServer((request, response) => {
    const phase = Math.floor(process.uptime()) % 600;
    const known = ["/", "/always-up", "/always-down", "/cycle"].includes(request.url);
    const failing = request.url === "/always-down" || (request.url === "/cycle" && phase < 60);
    response.writeHead(known ? (failing ? 503 : 200) : 404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ synthetic: true, ok: known && !failing, phaseSeconds: phase }));
});
server.listen(8080, "0.0.0.0");
process.on("SIGTERM", () => server.close());
