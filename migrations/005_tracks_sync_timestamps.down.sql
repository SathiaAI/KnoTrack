-- KnoTrack — 005_tracks_sync_timestamps.down.sql
-- Reverse of 005_tracks_sync_timestamps.sql — with one addition CodeRabbit
-- flagged on PR #6: DROP COLUMN on a populated timestamptz column is
-- silent, permanent data loss with no undo. scripts/migrate.ts has no
-- automated "down" mode yet (docs/ROADMAP.md T9.x backlog), so today the
-- only way this file runs at all is an operator invoking it directly —
-- but by the time that automated mode exists, or if it's ever run months
-- after 005 shipped rather than moments after, "empty table" is no longer
-- a safe assumption. Refuse rather than silently discard real sync
-- history; an operator who genuinely wants to drop populated columns can
-- do so explicitly (comment out the guard, or run the ALTER TABLE
-- directly) rather than have it happen as a side effect of routing
-- through this file.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tracks
    WHERE last_github_sync_at IS NOT NULL OR last_linear_sync_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Refusing to drop last_github_sync_at/last_linear_sync_at: at least one track has a non-NULL value. Back up or intentionally clear the data first if you really want to roll this back.';
  END IF;
END $$;

ALTER TABLE tracks
  DROP COLUMN last_github_sync_at,
  DROP COLUMN last_linear_sync_at;

COMMIT;
