-- KnoTrack — 009_track_external_links.down.sql
-- Reverse of 009_track_external_links.sql (T5.2). Following the 005 down
-- convention: dropping this table is permanent loss of every track->Issue
-- link, so refuse when any row exists rather than silently discarding sync
-- state. An operator who really wants to roll back clears the table first
-- (or comments out the guard). The shared set_updated_at() function is
-- left in place — other tables use it; DROP TABLE removes this table's own
-- trigger and index automatically.

BEGIN;

DO $$
BEGIN
  -- Guard the row check for a re-run where the table is already gone:
  -- SELECT ... FROM a missing table raises undefined_table and would abort
  -- the rollback before the idempotent DROP below.
  IF to_regclass('track_external_links') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM track_external_links) THEN
      RAISE EXCEPTION
        'Refusing to drop track_external_links: at least one row exists (a track is linked to or mid-sync with an external issue). Back up or intentionally clear the data first if you really want to roll this back.';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS track_external_links;

COMMIT;
