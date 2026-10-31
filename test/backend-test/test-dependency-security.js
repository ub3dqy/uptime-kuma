const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const tar = require("tar");
const protobuf = require("protobufjs");
const NotificationProvider = require("../../server/notification-providers/notification-provider");
const http = require("node:http");
const net = require("node:net");
const { createRequire } = require("node:module");

describe("Security dependency regressions", () => {
    test("release HTTP client preserves requests through an authenticated proxy", async (context) => {
        const consumer = createRequire(path.join(__dirname, "../../node_modules/@actions/github/package.json"));
        const { fetch, ProxyAgent } = consumer("undici");
        const sockets = new Set();
        const track = (socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.on("error", () => {});
        };
        const upstream = http.createServer((_request, response) => response.end("local upstream"));
        const proxy = http.createServer();
        for (const server of [upstream, proxy]) {
            server.on("connection", track);
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
        }
        let authorization;
        proxy.on("connect", (request, client, head) => {
            authorization = request.headers["proxy-authorization"];
            const target = net.connect(upstream.address().port, "127.0.0.1", () => {
                client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length) {
                    target.write(head);
                }
                client.pipe(target).pipe(client);
            });
            track(target);
            client.on("close", () => target.destroy());
        });
        const agent = new ProxyAgent({
            uri: `http://127.0.0.1:${proxy.address().port}`,
            pipelining: 1,
            token: "Basic dGVzdDp0ZXN0",
        });
        context.after(async () => {
            await agent.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await Promise.all([upstream, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
        });
        const response = await fetch(`http://127.0.0.1:${upstream.address().port}/`, { dispatcher: agent });
        assert.equal(await response.text(), "local upstream");
        assert.equal(authorization, "Basic dGVzdDp0ZXN0");
        assert.equal(typeof (await import("@actions/github")).getOctokit, "function");
    });

    test("notification templates finish on incomplete HTML and preserve ordinary text", async () => {
        // A subprocess bounds a synchronous parser regression that would otherwise hang the test runner.
        const script = `
            const Provider = require(process.argv[1]);
            new Provider().renderTemplate("{{ msg | strip_html }}", process.argv[2], null, null)
                .then(value => process.stdout.write(JSON.stringify(value)));
        `;
        for (const input of ["a<", "text<!--"]) {
            const { stdout } = await promisify(execFile)(
                process.execPath,
                ["-e", script, require.resolve("../../server/notification-providers/notification-provider"), input],
                { timeout: 5000, maxBuffer: 8192 }
            );
            assert.equal(JSON.parse(stdout), input);
        }
        assert.equal(
            await new NotificationProvider().renderTemplate("{{ msg | strip_html }}", "<b>Норма</b>", null, null),
            "Норма"
        );
    });

    test("protobuf normalizes schema-derived identifiers and preserves valid message conversion", () => {
        for (const name of ["Bad-name", 'Bad"name', "Bad[name]"]) {
            const type = new protobuf.Type(name);
            assert.match(type.name, /^[A-Za-z_$][\w$]*$/);
            type.setup();
        }
        const { root } = protobuf.parse('syntax = "proto3"; message Check { string value = 1; }');
        const type = root.lookupType("Check");
        const encoded = type.encode({ value: "Норма" }).finish();
        assert.deepEqual(type.toObject(type.decode(encoded)), { value: "Норма" });
    });

    test("tar preserves file and stream extraction and refuses explosive decompression", async (context) => {
        const parent = path.resolve(__dirname, "../../private");
        await fs.mkdir(parent, { recursive: true });
        const directory = await fs.mkdtemp(path.join(parent, "dependency-tar-"));
        context.after(async () => {
            assert.equal(path.dirname(directory), parent);
            assert.ok(path.basename(directory).startsWith("dependency-tar-"));
            await fs.rm(directory, { recursive: true, force: true });
        });
        const source = path.join(directory, "source");
        const target = path.join(directory, "target");
        await fs.mkdir(source);
        await fs.mkdir(target);
        await fs.writeFile(path.join(source, "check.txt"), "Обычный архив");
        const archive = path.join(directory, "normal.tar.gz");
        await tar.create({ cwd: source, gzip: true, file: archive }, ["check.txt"]);
        tar.extract({ file: archive, cwd: target, sync: true });
        assert.equal(await fs.readFile(path.join(target, "check.txt"), "utf8"), "Обычный архив");
        await fs.unlink(path.join(target, "check.txt"));
        await pipeline(require("node:fs").createReadStream(archive), tar.extract({ cwd: target }));
        assert.equal(await fs.readFile(path.join(target, "check.txt"), "utf8"), "Обычный архив");

        // The fixture is capped at 4 MiB even if the guard regresses.
        await fs.writeFile(path.join(source, "zeros"), Buffer.alloc(4 * 1024 * 1024));
        const compressed = [];
        for await (const chunk of tar.create({ cwd: source, gzip: true }, ["zeros"])) {
            compressed.push(chunk);
        }
        await assert.rejects(
            pipeline(Readable.from(compressed), tar.extract({ cwd: target })),
            /decompression ratio exceeded/
        );
    });
});
