-- You should not modify if this have pushed to Github, unless it does serious wrong with the db.
BEGIN TRANSACTION;

-- Rename COLUMNs to another one (suffixed by `_old`)
ALTER TABLE monitor
    RENAME COLUMN kafka_producer_ssl TO kafka_producer_ssl_old;

ALTER TABLE monitor
    RENAME COLUMN kafka_producer_allow_auto_topic_creation TO kafka_producer_allow_auto_topic_creation_old;

-- Add correct COLUMNs
ALTER TABLE monitor
    ADD COLUMN kafka_producer_ssl BOOLEAN default 0 NOT NULL;

ALTER TABLE monitor
    ADD COLUMN kafka_producer_allow_auto_topic_creation BOOLEAN default 0 NOT NULL;

-- Normalize legacy booleans before removing the original values.
-- Unknown non-empty TLS values remain enabled rather than silently weakening transport security.
UPDATE monitor SET kafka_producer_ssl = CASE
    WHEN kafka_producer_ssl_old IS NULL THEN 0
    WHEN typeof(kafka_producer_ssl_old) IN ('integer', 'real') THEN kafka_producer_ssl_old <> 0
    WHEN lower(trim(CAST(kafka_producer_ssl_old AS TEXT))) IN ('', '0', 'false', 'no', 'off') THEN 0
    ELSE 1
END;

UPDATE monitor SET kafka_producer_allow_auto_topic_creation = CASE
    WHEN typeof(kafka_producer_allow_auto_topic_creation_old) IN ('integer', 'real') THEN kafka_producer_allow_auto_topic_creation_old <> 0
    WHEN lower(trim(CAST(kafka_producer_allow_auto_topic_creation_old AS TEXT))) IN ('1', 'true', 'yes', 'on') THEN 1
    ELSE 0
END;

-- Remove old COLUMNs
ALTER TABLE monitor
    DROP COLUMN kafka_producer_allow_auto_topic_creation_old;

ALTER TABLE monitor
    DROP COLUMN kafka_producer_ssl_old;

COMMIT;
