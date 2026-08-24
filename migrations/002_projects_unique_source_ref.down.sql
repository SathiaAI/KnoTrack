-- KnoTrack — 002_projects_unique_source_ref.down.sql
-- Exact reverse of 002_projects_unique_source_ref.sql.

BEGIN;

DROP INDEX IF EXISTS uq_projects_source_ref_active;

COMMIT;
