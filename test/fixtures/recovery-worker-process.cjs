// A subprocess used only to prove durable recovery across abrupt process termination.
const path = require("node:path");
const { R } = require("redbean-node");
const filename = path.resolve(process.argv[2] || "");
const relative = path.relative(process.cwd(), filename).replaceAll("\\", "/");
if (
    process.env.TEST_BACKEND !== "1" ||
    !/^private\/project-tests-[a-f0-9]{16}\/vault\/crash-test\.db$/.test(relative) ||
    path.resolve(process.env.UPTIME_KUMA_PROJECT_KEY_FILE || "") !== path.join(path.dirname(filename), "keys.json") ||
    path.resolve(process.env.UPTIME_KUMA_RECOVERY_MANIFEST || "") !==
        path.join(path.dirname(filename), "recovery-manifest.json")
) {
    throw new Error("Foreign recovery process fixture refused");
}
const Dialect = require("knex/lib/dialects/sqlite3");
Dialect.prototype._driver = () => require("../../server/utils/sqlite-driver");
const db = require("knex")({ client: Dialect, connection: { filename }, useNullAsDefault: true });
R.setup(db);
const { worker } = require("../../server/projects/recovery");
let keepAlive;
(async () => {
    await require("../../server/projects/vault").initializeVaultState(db);
    await worker.start();
    if (!worker.ready) {
        throw new Error("Owned worker lock unavailable");
    }
    keepAlive = setInterval(() => {}, 1000);
})().catch(() => {
    process.exitCode = 1;
});
process.once("SIGTERM", async () => {
    await worker.stop();
    await db.destroy();
    clearInterval(keepAlive);
});
