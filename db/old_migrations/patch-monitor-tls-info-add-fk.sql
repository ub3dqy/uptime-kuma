-- Rebuild through public DDL; defensive SQLite forbids editing sqlite_master.
-- Keep existing orphan certificate rows from databases that predate ownership FKs.
-- Database.importSQLFile restores the connection setting even if the copy fails.
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE monitor_tls_info_new (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitor (id) ON DELETE CASCADE ON UPDATE CASCADE,
    info_json TEXT
);

INSERT INTO monitor_tls_info_new (id, monitor_id, info_json)
SELECT id, monitor_id, info_json FROM monitor_tls_info;

INSERT INTO sqlite_sequence (name, seq)
SELECT 'monitor_tls_info_new', seq FROM sqlite_sequence
WHERE name = 'monitor_tls_info'
AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'monitor_tls_info_new');

UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'monitor_tls_info'), 0))
WHERE name = 'monitor_tls_info_new';

DROP TABLE monitor_tls_info;
ALTER TABLE monitor_tls_info_new RENAME TO monitor_tls_info;

COMMIT;
PRAGMA foreign_keys = ON;
