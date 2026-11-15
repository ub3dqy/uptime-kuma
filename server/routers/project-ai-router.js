const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const router = express.Router();
const { complete } = require("../projects/subscription");
const { loginRateLimiter } = require("../rate-limiter");

router.post("/api/project-ai/import/:pairingID", express.json({ limit: "64kb" }), async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
        if (!(await loginRateLimiter.pass(null))) {
            response.status(429).json({ ok: false });
            return;
        }
        const authorization = request.get("authorization") || "";
        if (
            !/^Bearer [a-zA-Z0-9_-]{43}$/.test(authorization) ||
            Buffer.byteLength(JSON.stringify(request.body || null)) > 65536
        ) {
            response.status(403).json({ ok: false });
            return;
        }
        const result = await complete(request.params.pairingID, authorization.slice(7), request.body);
        response.json(result);
    } catch {
        response.status(403).json({ ok: false, msg: "projectSignInInvalid" });
    }
});

// Public static helper contains no deployment credentials or project data.
router.get("/api/project-ai/helper", (_request, response) => {
    response.setHeader("Content-Type", "application/javascript; charset=utf-8");
    response.setHeader("Content-Disposition", 'attachment; filename="uptime-kuma-ai-sign-in.cjs"');
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(fs.readFileSync(path.resolve(__dirname, "../../extra/project-ai-sign-in.cjs"), "utf8"));
});

module.exports = router;
