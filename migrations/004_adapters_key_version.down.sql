-- KnoTrack — 004_adapters_key_version.down.sql
-- Exact reverse of 004_adapters_key_version.sql.

BEGIN;

ALTER TABLE adapters
  DROP COLUMN key_version;

COMMIT;
