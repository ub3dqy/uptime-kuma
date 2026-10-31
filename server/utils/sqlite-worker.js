const { parentPort, workerData } = require("node:worker_threads");
const SQLite = require("better-sqlite3");

// Keep native queries and busy waits off the monitoring event loop.
let database;
try {
    database = new SQLite(workerData.filename, {
        readonly: workerData.readonly,
        fileMustExist: workerData.fileMustExist,
        timeout: 5000,
    });
    parentPort.postMessage({ id: 0 });
} catch (error) {
    parentPort.postMessage({ id: 0, error: { message: error.message, code: error.code } });
    parentPort.close();
}

if (database) {
    parentPort.on("message", ({ id, method, sql, bindings }) => {
        try {
            let result;
            let context = {};
            if (method === "close") {
                database.close();
            } else if (method === "exec") {
                database.exec(sql);
            } else {
                const statement = database.prepare(sql);
                const parameters = bindings.map((value) => {
                    if (typeof value === "boolean") {
                        return Number(value);
                    }
                    return value instanceof Date ? value.getTime() : value;
                });
                if (statement.reader) {
                    result = method === "get" ? statement.get(...parameters) : statement.all(...parameters);
                } else {
                    const info = statement.run(...parameters);
                    context = { lastID: Number(info.lastInsertRowid), changes: info.changes };
                    result = method === "all" ? [] : undefined;
                }
            }
            parentPort.postMessage({ id, result, context });
            if (method === "close") {
                parentPort.close();
            }
        } catch (error) {
            parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
        }
    });
}
