const MAX_EXPORT_ROWS = 50000;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_DAYS = 31;

/**
 * Validate a bounded, half-open UTC range before querying retained history.
 * @param {object} request Export request
 * @param {number} now Current timestamp
 * @returns {object} Validated request with SQL timestamps
 * @throws {Error} Invalid or excessive range
 */
function validateExportRequest(request, now = Date.now()) {
    if (!request || !Number.isSafeInteger(request.monitorID) || request.monitorID <= 0) {
        throw new Error("exportHistoryInvalidRange");
    }
    const dates = [request.start, request.end].map((value) => {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
            throw new Error("exportHistoryInvalidRange");
        }
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
            throw new Error("exportHistoryInvalidRange");
        }
        return timestamp;
    });
    if (dates[0] >= dates[1] || dates[1] - dates[0] > MAX_EXPORT_DAYS * 86400000 || dates[1] > now + 60000) {
        throw new Error("exportHistoryInvalidRange");
    }
    return {
        monitorID: request.monitorID,
        // Keep second-only legacy rows on exact zero-millisecond boundaries.
        start: request.start.replace("T", " ").replace(/(?:\.000)?Z$/, ""),
        end: request.end.replace("T", " ").replace(/(?:\.000)?Z$/, ""),
    };
}

/**
 * Quote CSV cells and neutralize spreadsheet formulas in untrusted text.
 * @param {unknown} value Cell value
 * @returns {string} Quoted CSV cell
 */
function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (
        typeof value === "string" &&
        (/^[\s\u0000-\u0020\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(text) || /^[\t\r\n]/.test(text))
    ) {
        text = "'" + text;
    }
    return '"' + text.replace(/"/g, '""') + '"';
}

/**
 * Serialize retained checks without exposing monitor credentials or response bodies.
 * @param {object} monitor Authorized monitor
 * @param {object[]} beats Retained heartbeat rows in chronological order
 * @returns {string} UTF-8 CSV with a BOM for spreadsheet import
 * @throws {Error} Export exceeds its size limits
 */
function buildHeartbeatCsv(monitor, beats) {
    if (beats.length > MAX_EXPORT_ROWS) {
        throw new Error("exportHistoryTooLarge");
    }
    const lines = ["\uFEFFmonitor_id,monitor_name,time_utc,status,ping_ms,duration_seconds,message\r\n"];
    let bytes = Buffer.byteLength(lines[0], "utf8");
    const statuses = ["DOWN", "UP", "PENDING", "MAINTENANCE"];
    for (const beat of beats) {
        const rawTime = beat.time instanceof Date ? beat.time.toISOString() : String(beat.time).replace(" ", "T") + "Z";
        const time = new Date(rawTime).toISOString();
        const row = [
            monitor.id,
            monitor.name,
            time,
            statuses[beat.status] ?? "UNKNOWN",
            beat.ping,
            beat.duration,
            beat.msg,
        ];
        const line = row.map(csvCell).join(",") + "\r\n";
        bytes += Buffer.byteLength(line, "utf8");
        if (bytes > MAX_EXPORT_BYTES) {
            throw new Error("exportHistoryTooLarge");
        }
        lines.push(line);
    }
    return lines.join("");
}

module.exports = { validateExportRequest, buildHeartbeatCsv, MAX_EXPORT_ROWS, MAX_EXPORT_BYTES };
