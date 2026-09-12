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

-- Same guard as 005_tracks_sync_timestamps.down.sql, for the same reason
-- (PR #16 Codex review, found on this exact file): decisions.effect and
-- decisions.resolves_decision_id are the only record of which decisions
-- opened or resolved a pivot, and which opening decision each resolution
-- closed. Once any real open_pivot/resolve_pivot decision has been
-- recorded, dropping these columns unconditionally destroys that
-- append-only audit history with no undo — silent, permanent data loss
-- disproportionate to what "roll back a migration" should do. Refuse
-- rather than guess at a safe default; an operator who genuinely wants to
-- discard this history can back it up first, then drop the columns
-- directly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM decisions WHERE effect <> 'note') THEN
    RAISE EXCEPTION
      'Refusing to drop decisions.effect/resolves_decision_id: at least one decision has effect <> ''note'' (an open_pivot/resolve_pivot record). Back up this audit history first if you really want to roll this back.';
  END IF;
END $$;

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
