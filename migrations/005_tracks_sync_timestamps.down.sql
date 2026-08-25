-- KnoTrack — 005_tracks_sync_timestamps.down.sql
-- Exact reverse of 005_tracks_sync_timestamps.sql.

BEGIN;

ALTER TABLE tracks
  DROP COLUMN last_github_sync_at,
  DROP COLUMN last_linear_sync_at;

COMMIT;
