-- KnoTrack — 006_derived_track_status.down.sql
-- Reverse of 006_derived_track_status.sql.
--
-- Data-loss note, same shape as 005_tracks_sync_timestamps.down.sql's
-- guard: tracks.status is being re-added, but there is no way to recover
-- the *historical* on_track/blocked/done value it used to hold — that
-- information was never meaningful in the first place (this whole
-- migration exists because 'done' was unreachable under the old column),
-- so the only sane restored value is the view's current computed status
-- at the moment of rollback, snapshotted once into the recreated column.
-- pivot_pending tracks round-trip correctly since pivot_decision_id
-- already encodes that fact independent of the view.

BEGIN;

-- ============================================================
-- Reverse of step 8: re-add tracks.status
-- ============================================================

ALTER TABLE tracks ADD COLUMN status text;

-- Snapshot the view's current computed value before the view itself is
-- dropped below.
UPDATE tracks
SET status = track_readiness.status
FROM track_readiness
WHERE tracks.id = track_readiness.id;

ALTER TABLE tracks
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'on_track',
  ADD CONSTRAINT tracks_status_check
    CHECK (status IN ('on_track', 'pivot_pending', 'blocked', 'done'));

-- ============================================================
-- Reverse of step 6: the view
-- ============================================================

DROP VIEW IF EXISTS track_readiness;

-- ============================================================
-- Reverse of step 5: cycle-prevention trigger
-- ============================================================

DROP TRIGGER IF EXISTS trg_track_dependencies_no_cycle ON track_dependencies;
DROP FUNCTION IF EXISTS reject_track_dependency_cycle();

-- ============================================================
-- Reverse of step 4 / step 2: pivot-pointer schema
-- ============================================================

DROP INDEX IF EXISTS tracks_pivot_decision_id_idx;
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_what_changed_required_for_pivots;
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_rationale_not_null;
DROP INDEX IF EXISTS decisions_resolves_decision_id_uq;
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_pivot_decision_fk;
DROP INDEX IF EXISTS decisions_track_id_effect_idx;
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_id_track_id_key;
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_resolves_requires_effect;
ALTER TABLE decisions DROP COLUMN IF EXISTS resolves_decision_id;
ALTER TABLE decisions DROP COLUMN IF EXISTS effect;
ALTER TABLE tracks DROP COLUMN IF EXISTS pivot_decision_id;

COMMIT;
