const { test } = require("node:test");
const assert = require("node:assert/strict");
const patch = require("../../server/projects/code-patch");
test("code paths and instructions are closed independently of the model schema", () => {
    for (const path of [
        "../x.py",
        "/etc/passwd",
        "a\\b.js",
        ".env",
        "lib/settings.py",
        "accounts/views.py",
        "lib/auth.js",
        "lib/a;id.js",
        "lib/a$(id).js",
        "lib/../../x.js",
    ]) {
        assert.equal(patch.allowedPath(path), false, path);
    }
    for (const path of ["lib/format.cjs", ".next/server/app/page.js", "site/index.html", "radio/format.py"]) {
        assert.equal(patch.allowedPath(path), true, path);
    }
    assert.throws(() =>
        patch.validateReview({
            verdict: "accept",
            summary: "Unsafe review",
            findings: [{ severity: "high", path: "lib/x.js", reason: "Data loss" }],
            limitations: [],
        })
    );
    assert.equal(
        patch.hash(patch.canonical({ z: "тест", a: 1 })),
        patch.hash('{"a":1,"z":"\\u0442\\u0435\\u0441\\u0442"}')
    );
});
