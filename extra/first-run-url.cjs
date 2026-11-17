// Called by the local launchers. A setup code never travels in an HTTP request URL.
const fs = require("node:fs");
const path = require("node:path");

const port = process.argv[2] || "3001";
if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) {
    console.error("Invalid local panel port");
    process.exitCode = 1;
} else {
    const file = path.join(process.env.DATA_DIR || "./data", ".setup-code");
    const code = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
    if (code && !/^[A-Za-z0-9_-]{32}$/.test(code)) {
        console.error("Unreadable installation code");
        process.exitCode = 1;
    } else {
        console.log("http://127.0.0.1:" + port + (code ? "/setup#code=" + code : "/dashboard"));
    }
}
