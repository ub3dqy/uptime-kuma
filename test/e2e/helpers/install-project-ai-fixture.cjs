// Loaded explicitly by the Playwright test command, never by the application.
if (require("node:worker_threads").isMainThread) {
    const fs = require("node:fs");
    const path = require("node:path");
    const data = process.env.KUMA_E2E_DATA_DIR || "";
    if (
        process.env.NODE_ENV !== "development" ||
        !/^private\/e2e-workspace-[a-f0-9]{12}$/.test(data) ||
        !process.argv.includes("--host=127.0.0.1") ||
        !process.argv.includes("--data-dir=./" + data)
    ) {
        throw new Error("Isolated AI transport refused");
    }
    const expectedFolder = path.resolve(data, "peer");
    if (path.resolve(process.env.KUMA_STAGE2_FIXTURE_DIR || "") !== expectedFolder) {
        throw new Error("Foreign fixture refused");
    }
    const config = JSON.parse(fs.readFileSync(path.join(expectedFolder, "ai-fixture.json"), "utf8"));
    const base = new URL(config.url);
    if (
        !config.synthetic ||
        base.protocol !== "http:" ||
        base.hostname !== "127.0.0.1" ||
        base.pathname !== "/" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
    ) {
        throw new Error("Nonlocal peer refused");
    }
    const clientModule = require("../../../server/projects/openai-client");
    const OriginalClient = clientModule.OpenAIClient;
    clientModule.OpenAIClient = class extends OriginalClient {
        constructor() {
            super({
                authorizeBase: new URL("/api/accounts/authorize", base).href,
                fetch: (url, options) => {
                    const original = new URL(url);
                    if (!["https://auth.openai.com", "https://api.openai.com"].includes(original.origin)) {
                        throw new Error("Unexpected fixture endpoint");
                    }
                    return fetch(new URL(original.pathname + original.search, base), { ...options, redirect: "error" });
                },
            });
        }
    };
    // Explicit test-only host transport: real loopback probes read this fixture's
    // file, while no production SSH connection or service can be selected.
    const hostFile = path.join(expectedFolder, "site-recovery.json");
    const hostJobs = new Map();
    const digest = (data) => require("node:crypto").createHash("sha256").update(data).digest("hex");
    require("../../../server/projects/site-recovery-client").setTestTransport({
        get config() {
            return { targets: fs.existsSync(hostFile) ? JSON.parse(fs.readFileSync(hostFile)).targets : [] };
        },
        request: async (target, operation, args) => {
            const fixture = JSON.parse(fs.readFileSync(hostFile));
            if (
                fixture.synthetic !== true ||
                ![fixture.file, fixture.baseline].every((file) =>
                    path.resolve(file).startsWith(expectedFolder + path.sep)
                )
            )
                throw new Error("Foreign host fixture refused");
            const bytes = fs.readFileSync(fixture.file);
            const hash = digest(bytes);
            if (operation.startsWith("code_")) {
                if (!fixture.code || !fixture.file.endsWith("availability.cjs"))
                    throw new Error("Foreign code fixture refused");
                const file = {
                    path: "lib/availability.cjs",
                    bytes: bytes.length,
                    sha256: hash,
                    windows: [{ offset: 0, text: bytes.toString() }],
                };
                if (operation === "code_index")
                    return {
                        ok: true,
                        targetID: target.id,
                        version: "isolated-code-fixture",
                        language: "javascript",
                        files: [{ path: file.path, bytes: file.bytes }],
                    };
                if (operation === "code_source")
                    return {
                        ok: true,
                        targetID: target.id,
                        jobID: args.jobID,
                        source: {
                            targetID: target.id,
                            jobID: args.jobID,
                            sourceHash: hash,
                            runtimeHash: hash,
                            policyHash: "c".repeat(64),
                            version: "isolated-code-fixture",
                            language: "javascript",
                            files: [file],
                        },
                    };
                let job = hostJobs.get(args.jobID);
                if (operation === "code_stage" && !job) {
                    if (
                        bytes.toString() !== "module.exports = n => n + 1;\n" ||
                        args.patch.changes[0].edits[0].after !== "n + 2"
                    )
                        throw new Error("Unexpected synthetic code patch");
                    job = {
                        phase: "qualified",
                        sourceHash: args.source.sourceHash,
                        patchHash: digest(require("../../../server/projects/code-patch").canonical(args.patch)),
                        qualificationHash: "d".repeat(64),
                        qualification: {
                            syntax: true,
                            regressionFailedBefore: true,
                            regressionPassedAfter: true,
                            tests: 1,
                            network: false,
                            productionData: false,
                        },
                        changes: [
                            { path: file.path, beforeHash: hash, afterHash: digest(fs.readFileSync(fixture.baseline)) },
                        ],
                    };
                    hostJobs.set(args.jobID, job);
                }
                if (!job) throw new Error("projectCodeRecoveryConflict");
                if (operation === "code_backup" && job.phase === "qualified") {
                    job.copy = path.join(expectedFolder, "code-point-" + args.jobID);
                    fs.writeFileSync(job.copy, bytes, { flag: "wx", mode: 0o600 });
                    job.backup = { digest: digest(bytes), files: 1, expiresAt: null, databaseIncluded: false };
                    job.phase = "backed_up";
                }
                if (operation === "code_apply" && job.phase === "backed_up") {
                    fs.writeFileSync(fixture.file, fs.readFileSync(fixture.baseline));
                    job.phase = "applied";
                    job.afterHash = digest(fs.readFileSync(fixture.file));
                }
                if (operation === "code_rollback" && job.phase === "applied") {
                    fs.writeFileSync(fixture.file, fs.readFileSync(job.copy));
                    job.phase = "rolled_back";
                    job.rollbackHash = digest(fs.readFileSync(fixture.file));
                }
                return {
                    ok: true,
                    targetID: target.id,
                    jobID: args.jobID,
                    sourceHash: job.sourceHash,
                    patchHash: job.patchHash,
                    qualificationHash: job.qualificationHash,
                    phase: job.phase,
                    planHash: args.planHash || null,
                    qualification: job.qualification,
                    changes: job.changes,
                    backup: job.backup,
                    afterHash: job.afterHash,
                    rollbackHash: job.rollbackHash,
                    currentHash: digest(fs.readFileSync(fixture.file)),
                };
            }
            if (operation === "inspect")
                return {
                    ok: true,
                    targetID: target.id,
                    action: "restart_service",
                    currentHash: hash,
                    policyHash: "c".repeat(64),
                    eligible: JSON.parse(bytes).broken,
                    facts: { running: true, localHTTPStatus: JSON.parse(bytes).broken ? 503 : 200 },
                };
            let job = hostJobs.get(args.jobID);
            if (operation === "backup" && !job) {
                const file = path.join(expectedFolder, "point-" + args.jobID);
                fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
                job = {
                    phase: "backed_up",
                    file,
                    backup: {
                        digest: digest(fs.readFileSync(file)),
                        files: 1,
                        databaseIncluded: false,
                        expiresAt: null,
                    },
                };
                hostJobs.set(args.jobID, job);
            }
            if (!job) throw new Error("projectSiteRecoveryConflict");
            if (operation === "apply" && job.phase === "backed_up") {
                if (hash !== args.expectedHash) throw new Error("projectSiteRecoveryConflict");
                fs.writeFileSync(fixture.file, fs.readFileSync(fixture.baseline));
                job.phase = "applied";
                job.afterHash = digest(fs.readFileSync(fixture.file));
            }
            if (operation === "rollback" && job.phase === "applied") {
                if (hash !== job.afterHash) throw new Error("projectSiteRecoveryConflict");
                fs.writeFileSync(fixture.file, fs.readFileSync(job.file));
                job.phase = "rolled_back";
                job.rollbackHash = digest(fs.readFileSync(fixture.file));
            }
            const receipt = {
                phase: job.phase,
                backup: job.backup,
                afterHash: job.afterHash,
                rollbackHash: job.rollbackHash,
            };
            return {
                ok: true,
                targetID: target.id,
                jobID: args.jobID,
                planHash: args.planHash,
                at: Date.now(),
                ...receipt,
            };
        },
    });
}
