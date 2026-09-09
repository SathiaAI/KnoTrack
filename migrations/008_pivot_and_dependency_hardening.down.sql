-- KnoTrack — 008_pivot_and_dependency_hardening.down.sql
-- Reverse of 008_pivot_and_dependency_hardening.sql.
--
-- Restores the state left by migration 007 (same-track-only FK on
-- resolves_decision_id, two-column pivot_decision_id FK, no
-- project-scoping on track_dependencies, original cycle trigger).

BEGIN;

-- ============================================================
-- Reverse of Finding 4: restore the original trigger function
-- ============================================================

CREATE OR REPLACE FUNCTION reject_track_dependency_cycle() RETURNS trigger AS $$
DECLARE
  would_cycle boolean;
BEGIN
  WITH RECURSIVE reach(node) AS (
    SELECT NEW.depends_on_track_id
    UNION
    SELECT td.depends_on_track_id
    FROM track_dependencies td
    JOIN reach r ON td.track_id = r.node
  )
  SELECT EXISTS (SELECT 1 FROM reach WHERE node = NEW.track_id) INTO would_cycle;

  IF would_cycle THEN
    RAISE EXCEPTION
      'track_dependencies: inserting/updating (track_id=%, depends_on_track_id=%) would create a dependency cycle',
      NEW.track_id, NEW.depends_on_track_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Reverse of Finding 3: drop track_dependencies project-scoping
-- ============================================================

ALTER TABLE track_dependencies DROP CONSTRAINT IF EXISTS td_dep_same_project;
ALTER TABLE track_dependencies DROP CONSTRAINT IF EXISTS td_track_same_project;
ALTER TABLE track_dependencies DROP COLUMN IF EXISTS project_id;
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_id_project_key;

-- ============================================================
-- Reverse of Finding 2 (full fix): restore migration 007's
-- same-track-only FK
-- ============================================================

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_resolves_open_pivot_fk;
ALTER TABLE decisions DROP COLUMN IF EXISTS resolves_target_effect;
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_track_id_required_for_pivots;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_resolves_same_track_fk
    FOREIGN KEY (resolves_decision_id, track_id)
    REFERENCES decisions (id, track_id);

-- ============================================================
-- Reverse of Finding 1: restore the two-column pivot_decision_id FK
-- ============================================================

ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_pivot_decision_fk;
ALTER TABLE tracks
  ADD CONSTRAINT tracks_pivot_decision_fk
    FOREIGN KEY (pivot_decision_id, id) REFERENCES decisions (id, track_id)
    ON DELETE NO ACTION;
ALTER TABLE tracks DROP COLUMN IF EXISTS pivot_effect;

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_id_track_effect_key;

COMMIT;
