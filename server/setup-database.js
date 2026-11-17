const express = require("express");
const { log } = require("../src/util");
const expressStaticGzip = require("express-static-gzip");
const fs = require("fs");
const path = require("path");
const Database = require("./database");
const { allowDevAllOrigin, printServerUrls } = require("./util-server");
const mysql = require("mysql2/promise");
const { isSSL, sslKey, sslCert, sslKeyPassphrase } = require("./config");
const https = require("https");
const { matchesSetupCode } = require("./setup-access");

/**
 * Reads a configuration value from an environment variable or a Docker secrets file.
 * If both the direct env var and the _FILE variant are set, an error is thrown.
 * @param {string} envName The base name of the environment variable (e.g., "UPTIME_KUMA_DB_PASSWORD")
 * @returns {string|undefined} The value from the env var, file contents (trimmed), or undefined if neither is set
 * @throws {Error} If both the direct env var and the _FILE variant are set
 */
function getEnvOrFile(envName) {
    const directValue = process.env[envName];
    const fileValue = process.env[envName + "_FILE"];

    if (directValue && fileValue) {
        throw new Error(`Both ${envName} and ${envName}_FILE are set. Please use only one.`);
    }

    if (fileValue) {
        try {
            return fs.readFileSync(fileValue, "utf8").trim();
        } catch (err) {
            throw new Error(`Failed to read ${envName}_FILE at ${fileValue}: ${err.message}`);
        }
    }

    return directValue;
}

/**
 *  A standalone express app that is used to setup a database
 *  It is used when db-config.json and kuma.db are not found or invalid
 *  Once it is configured, it will shut down and start the main server
 */
class SetupDatabase {
    /**
     * Show Setup Page
     * @type {boolean}
     */
    needSetup = true;
    /**
     * If the server has finished the setup
     * @type {boolean}
     * @private
     */
    runningSetup = false;
    /**
     * @inheritDoc
     * @type {UptimeKumaServer}
     * @private
     */
    server;

    /**
     * @param  {object} args The arguments passed from the command line
     * @throws {Error} Saved database settings are invalid
     * @param  {UptimeKumaServer} server the main server instance
     */
    constructor(args, server) {
        this.server = server;

        const requestedType = process.env.UPTIME_KUMA_DB_TYPE;
        if (requestedType) {
            Database.writeDBConfig({
                type: requestedType,
                hostname: process.env.UPTIME_KUMA_DB_HOSTNAME,
                port: process.env.UPTIME_KUMA_DB_PORT,
                dbName: process.env.UPTIME_KUMA_DB_NAME,
                username: getEnvOrFile("UPTIME_KUMA_DB_USERNAME"),
                password: getEnvOrFile("UPTIME_KUMA_DB_PASSWORD"),
                socketPath: process.env.UPTIME_KUMA_DB_SOCKET?.trim(),
                ssl: getEnvOrFile("UPTIME_KUMA_DB_SSL")?.toLowerCase() === "true",
                ca: getEnvOrFile("UPTIME_KUMA_DB_CA"),
            });
            this.needSetup = false;
            return;
        }
        try {
            Database.readDBConfig();
            this.needSetup = false;
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw new Error("The saved database settings could not be read. Check db-config.json in the data directory.");
            }
            if (fs.existsSync(path.join(Database.dataDir, "kuma.db")) || process.env.UPTIME_KUMA_SETUP_DATABASE !== "1") {
                Database.writeDBConfig({ type: "sqlite" });
                this.needSetup = false;
            }
        }
    }

    /**
     * Show Setup Page
     * @returns {boolean} true if the setup page should be shown
     */
    isNeedSetup() {
        return this.needSetup;
    }

    /**
     * Check if the embedded MariaDB is enabled
     * @returns {boolean} true if the embedded MariaDB is enabled
     */
    isEnabledEmbeddedMariaDB() {
        return process.env.UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB === "1";
    }

    /**
     * Start the setup-database server
     * @param {string} hostname where the server is listening
     * @param {number} port where the server is listening
     * @param {string} setupCode Private installation code
     * @returns {Promise<void>}
     */
    start(hostname, port, setupCode) {
        return new Promise((resolve) => {
            const app = express();
            let tempServer;
            app.use(express.json({ limit: "32kb" }));

            // Disable Keep Alive, otherwise the server will not shutdown, as the client will keep the connection alive
            app.use(function (req, res, next) {
                res.setHeader("Connection", "close");
                next();
            });

            app.get("/", async (request, response) => {
                response.redirect("/setup-database");
            });

            app.get("/api/entry-page", async (request, response) => {
                allowDevAllOrigin(response);
                response.json({
                    type: "setup-database",
                });
            });

            app.get("/setup-database-info", (request, response) => {
                allowDevAllOrigin(response);
                console.log("Request /setup-database-info");
                response.json({
                    runningSetup: this.runningSetup,
                    needSetup: this.needSetup,
                    isEnabledEmbeddedMariaDB: this.isEnabledEmbeddedMariaDB(),
                    isEnabledMariaDBSocket: process.env.UPTIME_KUMA_DB_SOCKET?.trim().length > 0,
                });
            });

            app.post("/setup-database", async (request, response) => {
                allowDevAllOrigin(response);

                response.setHeader("Cache-Control", "no-store");
                if (!matchesSetupCode(request.body?.code, setupCode)) {
                    response.status(403).json({ error: "setupCodeInvalid" });
                    return;
                }
                if (this.runningSetup) {
                    response.status(400).json("Setup is already running");
                    return;
                }

                this.runningSetup = true;

                let dbConfig = request.body.dbConfig;

                let supportedDBTypes = ["mariadb", "sqlite"];

                if (this.isEnabledEmbeddedMariaDB()) {
                    supportedDBTypes.push("embedded-mariadb");
                }

                // Validate input
                if (!dbConfig || typeof dbConfig !== "object" || Array.isArray(dbConfig)) {
                    response.status(400).json("Invalid dbConfig");
                    this.runningSetup = false;
                    return;
                }

                if (!dbConfig.type) {
                    response.status(400).json("Database Type is required");
                    this.runningSetup = false;
                    return;
                }

                if (!supportedDBTypes.includes(dbConfig.type)) {
                    response.status(400).json("Unsupported Database Type");
                    this.runningSetup = false;
                    return;
                }

                // External MariaDB
                if (dbConfig.type === "mariadb") {
                    // If socketPath is provided and not empty, validate it
                    if (process.env.UPTIME_KUMA_DB_SOCKET?.trim().length > 0) {
                        dbConfig.socketPath = process.env.UPTIME_KUMA_DB_SOCKET.trim();
                    } else {
                        // socketPath not provided, hostname and port are required
                        if (!dbConfig.hostname) {
                            response.status(400).json("Hostname is required");
                            this.runningSetup = false;
                            return;
                        }

                        if (!dbConfig.port) {
                            response.status(400).json("Port is required");
                            this.runningSetup = false;
                            return;
                        }
                    }

                    if (!dbConfig.dbName) {
                        response.status(400).json("Database name is required");
                        this.runningSetup = false;
                        return;
                    }

                    if (!dbConfig.username) {
                        response.status(400).json("Username is required");
                        this.runningSetup = false;
                        return;
                    }

                    if (!dbConfig.password) {
                        response.status(400).json("Password is required");
                        this.runningSetup = false;
                        return;
                    }

                    // Test connection
                    try {
                        log.info("setup-database", "Testing database connection...");
                        const connection = await mysql.createConnection({
                            connectTimeout: 8000,
                            host: dbConfig.hostname,
                            port: dbConfig.port,
                            user: dbConfig.username,
                            password: dbConfig.password,
                            database: dbConfig.dbName,
                            socketPath: dbConfig.socketPath,
                            ...(dbConfig.ssl
                                ? {
                                      ssl: {
                                          rejectUnauthorized: true,
                                          ...(dbConfig.ca && dbConfig.ca.trim() !== "" ? { ca: [dbConfig.ca] } : {}),
                                      },
                                  }
                                : {}),
                        });
                        try {
                            await connection.query({ sql: "SELECT 1", timeout: 5000 });
                        } finally {
                            connection.destroy();
                        }
                    } catch {
                        response.status(400).json({ error: "setupDatabaseUnavailable" });
                        this.runningSetup = false;
                        return;
                    }
                }

                try {
                    Database.writeDBConfig(dbConfig);
                } catch {
                    response.status(500).json({ error: "setupSaveFailed" });
                    this.runningSetup = false;
                    return;
                }

                response.json({
                    ok: true,
                });

                // Shutdown down this express and start the main server
                log.info(
                    "setup-database",
                    "Database is configured, close the setup-database server and start the main server now."
                );
                if (tempServer) {
                    tempServer.close(() => {
                        log.info("setup-database", "The setup-database server is closed");
                        resolve();
                    });
                } else {
                    resolve();
                }
            });

            app.use(
                "/",
                expressStaticGzip("dist", {
                    enableBrotli: true,
                })
            );

            app.get("/{*splat}", async (_request, response) => {
                response.send(this.server.indexHTML);
            });

            app.options("/{*splat}", async (_request, response) => {
                allowDevAllOrigin(response);
                response.end();
            });

            let server;

            if (isSSL) {
                server = tempServer = https.createServer(
                    {
                        key: fs.readFileSync(sslKey),
                        cert: fs.readFileSync(sslCert),
                        passphrase: sslKeyPassphrase,
                    },
                    app
                );
            } else {
                server = app;
            }

            tempServer = server.listen(port, hostname, () => {
                log.info("setup-database", "Starting Setup Database");
                printServerUrls("setup-database", port, hostname, isSSL);
                log.info("setup-database", "Waiting for user action...");
            });
        });
    }
}

module.exports = {
    SetupDatabase,
};
