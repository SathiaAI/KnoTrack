-- KnoTrack — 001_init.down.sql
-- Exact reverse of 001_init.sql. Drops objects in reverse dependency
-- order so no DROP ever fails on a still-referencing foreign key.
--
-- Note: DROP TABLE implicitly drops that table's own indexes,
-- constraints, and triggers, so they are not dropped individually
-- below — only objects that are NOT owned by a single table (the
-- shared trigger function) get an explicit DROP.

BEGIN;

-- ============================================================
-- drift_flags
-- ============================================================
DROP TABLE IF EXISTS drift_flags;

-- ============================================================
-- api_tokens
-- ============================================================
DROP TABLE IF EXISTS api_tokens;

-- ============================================================
-- decisions
-- ============================================================
DROP TABLE IF EXISTS decisions;

-- ============================================================
-- events
-- ============================================================
DROP TABLE IF EXISTS events;

-- ============================================================
-- item_dependencies
-- ============================================================
DROP TABLE IF EXISTS item_dependencies;

-- ============================================================
-- items
-- ============================================================
DROP TABLE IF EXISTS items;

-- ============================================================
-- track_dependencies
-- ============================================================
DROP TABLE IF EXISTS track_dependencies;

-- ============================================================
-- tracks
-- ============================================================
DROP TABLE IF EXISTS tracks;

-- ============================================================
-- adapters
-- ============================================================
DROP TABLE IF EXISTS adapters;

-- ============================================================
-- projects
-- ============================================================
DROP TABLE IF EXISTS projects;

-- ============================================================
-- Shared trigger function
-- ============================================================
DROP FUNCTION IF EXISTS set_updated_at();

-- ============================================================
-- Extensions
-- ============================================================
-- Deliberately NOT dropped: pgcrypto is a database-wide extension that
-- other schemas/migrations in the same database may depend on, and
-- DROP EXTENSION here would be an out-of-band, hard-to-reverse
-- decision for a migration whose job is just to undo 001_init's own
-- objects. Uncomment only if you are certain nothing else uses it:
-- DROP EXTENSION IF EXISTS pgcrypto;

COMMIT;
