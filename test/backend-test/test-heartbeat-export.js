const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { validateExportRequest, buildHeartbeatCsv, MAX_EXPORT_ROWS } = require("../../server/heartbeat-export");

const request = { monitorID: 1, start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z" };
const now = Date.parse("2026-10-31T00:00:00.000Z");

describe("Retained heartbeat CSV export", () => {
    test("validates exact UTC bounds and rejects malformed or unbounded requests", () => {
        assert.deepEqual(validateExportRequest(request, now), {
            monitorID: 1,
            start: "2026-10-01 00:00:00",
            end: "2026-10-02 00:00:00",
        });
        for (const bad of [
            null,
            {},
            { ...request, monitorID: "1" },
            { ...request, monitorID: -1 },
            { ...request, start: "2026-02-30T00:00:00.000Z" },
            { ...request, start: request.end },
            { ...request, end: "2026-11-10T00:00:00.000Z" },
            { ...request, end: "2026-10-02T00:00:00+03:00" },
        ]) {
            assert.throws(() => validateExportRequest(bad, now), /exportHistoryInvalidRange/);
        }
        assert.throws(() => validateExportRequest(request, Date.parse(request.start)), /exportHistoryInvalidRange/);
    });

    test("exports raw status, zero ping, UTC and quoted Unicode messages without private fields", () => {
        const csv = buildHeartbeatCsv({ id: 1, name: 'Сайт, "клиент"', password: "secret" }, [
            {
                time: "2026-10-01 00:00:00.000",
                status: 1,
                ping: 0,
                duration: 60,
                msg: 'OK, "ответ"\nстрока',
                response: "private-body",
            },
            { time: new Date(request.start), status: 3, ping: null, duration: 0, msg: null },
        ]);
        assert.ok(csv.startsWith("\uFEFFmonitor_id,"));
        assert.ok(csv.includes('"Сайт, ""клиент"""'));
        assert.ok(csv.includes('"2026-10-01T00:00:00.000Z","UP","0","60"'));
        assert.ok(csv.includes('"OK, ""ответ""\nстрока"'));
        assert.ok(csv.includes('"MAINTENANCE","","0",""'));
        assert.ok(!csv.includes("secret") && !csv.includes("private-body"));
    });

    test("neutralizes spreadsheet formulas, including whitespace-prefixed input", () => {
        for (const value of [
            "=1+1",
            "+cmd",
            "-cmd",
            "@SUM(A1)",
            "  =1",
            "\u0000=1",
            "＝1",
            "＋1",
            "－1",
            "＠SUM(A1)",
            "\ttext",
            "\rtext",
            "\ntext",
        ]) {
            const csv = buildHeartbeatCsv({ id: 1, name: value }, [
                { time: "2026-10-01 00:00:00", status: 0, msg: value },
            ]);
            assert.ok(csv.includes("\"'" + value + '"'), JSON.stringify(value));
        }
    });

    test("refuses oversized exports instead of silently truncating them", () => {
        assert.throws(
            () => buildHeartbeatCsv({ id: 1, name: "x" }, new Array(MAX_EXPORT_ROWS + 1)),
            /exportHistoryTooLarge/
        );
        const beat = { time: "2026-10-01 00:00:00", status: 0, msg: "x".repeat(1024 * 1024) };
        assert.throws(() => buildHeartbeatCsv({ id: 1, name: "x" }, new Array(9).fill(beat)), /exportHistoryTooLarge/);
    });
});
