const path = require("node:path");
const protocol = require("../server/ai-worker/protocol");
const { createWorker } = require("../server/ai-worker/server");
let worker;
try {
    const config = protocol.readConfiguration(process.env.UPTIME_KUMA_AI_WORKER_CONFIG || "/app/worker-config.json");
    const port = Number(process.env.UPTIME_KUMA_PORT || 3047);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw protocol.failure();
    worker = createWorker({
        config,
        directory: path.resolve(process.env.UPTIME_KUMA_AI_WORKER_DATA || "/app/worker-data"),
    });
    worker.server.listen(port, "0.0.0.0", () => {
        process.stdout.write("Private OpenAI worker ready\n");
    });
    worker.server.on("error", () => {
        process.stderr.write("Private OpenAI worker unavailable\n");
        process.exitCode = 1;
    });
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        await worker.close();
        process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
} catch {
    process.stderr.write("Private OpenAI worker configuration invalid\n");
    process.exitCode = 2;
}
