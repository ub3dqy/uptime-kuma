const { Worker } = require("node:worker_threads");
const path = require("node:path");

/**
 * Restore Buffers after structured clone.
 * @param {any} value Result value.
 * @returns {any} Restored value.
 */
function restoreBuffers(value) {
    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    if (Array.isArray(value)) {
        return value.map(restoreBuffers);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreBuffers(item)]));
    }
    return value;
}

/**
 * The callback subset used by Knex's SQLite dialect and database initialization.
 */
class Database {
    /**
     * @param {string} filename Database path.
     * @param {number|Function} flags Open flags or callback.
     * @param {Function} callback Open callback.
     */
    constructor(filename, flags, callback) {
        if (typeof flags === "function") {
            callback = flags;
            flags = 6;
        }
        this.pending = new Map();
        this.sequence = 0;
        this.closed = false;
        this.closing = false;
        this.pending.set(0, callback);
        this.worker = new Worker(path.join(__dirname, "sqlite-worker.js"), {
            workerData: { filename, readonly: !!(flags & 1), fileMustExist: !(flags & 4) },
        });
        this.worker.on("message", ({ id, result, context, error }) => {
            const done = this.pending.get(id);
            this.pending.delete(id);
            if (error && id === 0) {
                this.closed = true;
            }
            if (done) {
                done.call(
                    context || this,
                    error ? Object.assign(new Error(error.message), { code: error.code }) : null,
                    restoreBuffers(result)
                );
            }
        });
        this.worker.on("error", (error) => this.failPending(error));
        this.worker.on("exit", () => {
            this.closed = true;
            this.failPending(Object.assign(new Error("SQLite worker closed"), { code: "SQLITE_MISUSE" }));
        });
    }

    /**
     * @param {Error} error Worker failure.
     * @returns {void}
     */
    failPending(error) {
        this.closed = true;
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const done of pending) {
            done?.call(this, error);
        }
    }

    /**
     * @param {string} method Operation.
     * @param {string} sql SQL statement.
     * @param {any[]} bindings Parameters.
     * @param {Function} callback Completion callback.
     * @returns {Database} This connection.
     */
    request(method, sql, bindings, callback) {
        if (this.closed || this.closing) {
            queueMicrotask(() => callback?.(Object.assign(new Error("Database is closed"), { code: "SQLITE_MISUSE" })));
            return this;
        }
        if (method === "close") {
            this.closing = true;
        }
        const id = ++this.sequence;
        this.pending.set(id, callback);
        try {
            this.worker.postMessage({ id, method, sql, bindings });
        } catch (error) {
            this.pending.delete(id);
            queueMicrotask(() => callback?.(error));
        }
        return this;
    }

    /**
     * @param {string} sql Statement.
     * @param {any[]|Function} bindings Parameters or callback.
     * @param {Function} callback Completion callback.
     * @returns {Database} This connection.
     */
    run(sql, bindings, callback) {
        return this.request(
            "run",
            sql,
            typeof bindings === "function" ? [] : bindings || [],
            typeof bindings === "function" ? bindings : callback
        );
    }

    /**
     * @param {string} sql Statement.
     * @param {any[]|Function} bindings Parameters or callback.
     * @param {Function} callback Completion callback.
     * @returns {Database} This connection.
     */
    all(sql, bindings, callback) {
        return this.request(
            "all",
            sql,
            typeof bindings === "function" ? [] : bindings || [],
            typeof bindings === "function" ? bindings : callback
        );
    }

    /**
     * @param {string} sql Statement.
     * @param {any[]|Function} bindings Parameters or callback.
     * @param {Function} callback Completion callback.
     * @returns {Database} This connection.
     */
    get(sql, bindings, callback) {
        return this.request(
            "get",
            sql,
            typeof bindings === "function" ? [] : bindings || [],
            typeof bindings === "function" ? bindings : callback
        );
    }

    /**
     * @param {string} sql Statements.
     * @param {Function} callback Completion callback.
     * @returns {Database} This connection.
     */
    exec(sql, callback) {
        return this.request("exec", sql, [], callback);
    }

    /**
     * @param {Function} callback Completion callback.
     * @returns {Database} This connection.
     */
    close(callback) {
        return this.request("close", "", [], callback);
    }
}

module.exports = { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
