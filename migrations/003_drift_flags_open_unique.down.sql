-- KnoTrack — 003_drift_flags_open_unique.down.sql
-- Exact reverse of 003_drift_flags_open_unique.sql.

BEGIN;

DROP INDEX IF EXISTS uq_drift_flags_open_item_kind;

COMMIT;
