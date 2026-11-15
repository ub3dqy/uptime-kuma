const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Database = require("better-sqlite3");
const { setup, approve } = require("../fixtures/recovery-workspace.cjs");
const recovery = require("../../server/projects/recovery");

/**
 * @param {Function} predicate Read-only owned state
 * @returns {Promise<void>} Bounded condition wait
 */
async function until(predicate) {
    const deadline = Date.now() + 25000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "Owned child did not reach its expected durable state");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

test(
    "abrupt process death after file replacement restores the durable snapshot without repeating the forward change",
    { timeout: 90000 },
    async (t) => {
        const value = await setup(t);
        const action = await approve(value);
        await recovery.worker.stop();
        const filename = path.join(path.dirname(value.manifest), "crash-test.db");
        await value.db.raw("VACUUM INTO ?", [filename]);
        const retained = new Database(filename, { fileMustExist: true, timeout: 10000 });
        let child;
        const launch = () => {
            const childProcess = spawn(
                process.execPath,
                [path.resolve("test/fixtures/recovery-worker-process.cjs"), filename],
                { env: process.env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] }
            );
            const exited = new Promise((resolve, reject) => {
                childProcess.once("exit", resolve);
                childProcess.once("error", reject);
            });
            return { process: childProcess, exited };
        };
        try {
            child = launch();
            await until(
                () =>
                    retained.prepare("SELECT status FROM project_recovery WHERE id=?").get(action.id).status ===
                    "verifying"
            );
            assert.deepEqual(fs.readFileSync(value.file), value.after);
            const snapshot = retained
                .prepare("SELECT snapshot_cipher FROM project_recovery WHERE id=?")
                .get(action.id).snapshot_cipher;
            assert.ok(snapshot);
            child.process.kill("SIGKILL");
            await child.exited;
            child = launch();
            await until(
                () =>
                    retained.prepare("SELECT status FROM project_recovery WHERE id=?").get(action.id).status ===
                    "verifying_rollback"
            );
            assert.deepEqual(fs.readFileSync(value.file), value.before);
            retained
                .prepare("INSERT INTO heartbeat(monitor_id,time,status,check_interval,check_session) VALUES(?,?,?,?,?)")
                .run(value.monitorID, new Date().toISOString(), 0, 20, "owned-continuous-session");
            await until(
                () =>
                    retained.prepare("SELECT status FROM project_recovery WHERE id=?").get(action.id).status ===
                    "rolled_back"
            );
            const completed = retained.prepare("SELECT * FROM project_recovery WHERE id=?").get(action.id);
            assert.equal(completed.error_code, "projectRecoveryInterrupted");
            assert.equal(completed.snapshot_cipher, snapshot);
            assert.equal(retained.prepare("SELECT COUNT(*) AS n FROM project_recovery").get().n, 1);
        } finally {
            if (child?.process.exitCode === null) {
                child.process.kill("SIGKILL");
                await child.exited;
            }
            retained.close();
        }
    }
);
