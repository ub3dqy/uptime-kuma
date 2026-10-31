const { Cron: CurrentCron } = require("croner");

/**
 * Preserve the stored Croner 8 question-mark placeholders at job creation.
 * @param {string|Date} pattern Stored schedule.
 * @param {string} timezone Job timezone.
 * @param {Date} now Creation time.
 * @returns {string|Date} Schedule understood by current Croner.
 */
function expandLegacyPlaceholders(pattern, timezone, now = new Date()) {
    if (typeof pattern !== "string" || !pattern.includes("?")) {
        return pattern;
    }
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hourCycle: "h23",
            second: "numeric",
            minute: "numeric",
            hour: "numeric",
            day: "numeric",
            month: "numeric",
            weekday: "short",
        })
            .formatToParts(now)
            .map(({ type, value }) => [type, value])
    );
    const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const values = [parts.second, parts.minute, parts.hour, parts.day, parts.month, weekdays[parts.weekday]];
    const fields = pattern.trim().split(/\s+/);
    const offset = fields.length === 5 ? 1 : 0;
    return fields.map((field, index) => field.replaceAll("?", String(Number(values[index + offset])))).join(" ");
}

class Cron extends CurrentCron {
    /**
     * @param {string|Date} pattern Schedule.
     * @param {object|Function} options Settings or handler.
     * @param {Function} callback Handler.
     */
    constructor(pattern, options = {}, callback) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        super(expandLegacyPlaceholders(pattern, options.timezone), { ...options, sloppyRanges: true }, callback);
    }
}

module.exports = { Cron, expandLegacyPlaceholders };
