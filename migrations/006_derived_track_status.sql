-- KnoTrack — 006_derived_track_status.sql
--
-- T2.16 (docs/ROADMAP.md): switches tracks.status from a stored,
-- hand-maintained column (which had no write path that ever set 'done',
-- so no track could ever complete and no dependent could ever unblock)
-- to a value computed at read time by the track_readiness view below.
-- Full design history: two rounds of independent multi-model review plus
-- a direct sign-off/correction from Paul (2026-09-08) — see the project
-- doc "T2.16 — Track Lifecycle: Derived Status (Final Design, v2)" for
-- the complete rationale. This migration is that design's schema half;
-- the application-code half (src/mcp/tools/*, src/db/queries/tracks.ts,
-- src/db/queries/decisions.ts) ships in the same PR/deploy — see this
-- file's own step markers below for the reasoning at each point, mirroring
-- the final design doc's §7 migration plan 1:1.
--
-- Data-integrity audit (design doc §7 step 1): this migration does not
-- include an automated audit query, because there is no automated way to
-- "diff" a value about to be deleted (the old stored tracks.status)
-- against a value that only exists after this same migration creates the
-- view — the two can't coexist mid-migration without keeping the old
-- column around as dead weight past its own removal. For a deployment
-- with real pivot data, run this manually against the target database
-- BEFORE applying this migration, to see which tracks are currently
-- pivot_pending (the only state this migration has to preserve/backfill):
--   SELECT id, title, status FROM tracks WHERE status = 'pivot_pending';
-- Step 3 below backfills every one of those into the new pivot-pointer
-- model automatically; nothing else about the old status column's value
-- needs preserving, since on_track/blocked/done were already wrong by
-- construction (this whole migration exists because 'done' could never
-- be reached) and are fully superseded by the view's live computation.

BEGIN;

-- ============================================================
-- Step 2 (design doc §7): additive schema changes
-- ============================================================

ALTER TABLE decisions
  ADD COLUMN effect text NOT NULL DEFAULT 'note'
    CHECK (effect IN ('note', 'open_pivot', 'resolve_pivot')),
  ADD COLUMN resolves_decision_id uuid REFERENCES decisions (id);

-- Composite unique key backing the ownership-enforcing FK added in step 4
-- below (`id` is already unique via the PK; pairing it with `track_id`
-- costs nothing extra and lets tracks.pivot_decision_id's FK target
-- "this exact (decision, track) pair" instead of just "some decision
-- exists somewhere").
ALTER TABLE decisions
  ADD CONSTRAINT decisions_id_track_id_key UNIQUE (id, track_id);

ALTER TABLE tracks ADD COLUMN pivot_decision_id uuid;

CREATE INDEX decisions_track_id_effect_idx ON decisions (track_id, effect);

-- ============================================================
-- Step 3 (design doc §7): backfill
-- ============================================================

-- Every track currently sitting at the old stored status='pivot_pending'
-- gets a synthesized 'open_pivot' decision so it keeps reading as
-- pivot_pending under the new pointer model, with an honest placeholder
-- rationale rather than inventing one. This subsumes the manual audit
-- query in this file's header comment for any track it actually finds.
WITH pivoted AS (
  SELECT id, project_id
  FROM tracks
  WHERE status = 'pivot_pending'
),
inserted AS (
  INSERT INTO decisions (project_id, track_id, title, rationale, what_changed, effect)
  SELECT
    project_id,
    id,
    'Pivot pre-dates decision-linked pivots',
    'This pivot was opened before tracks.pivot_decision_id existed; the ' ||
      'original rationale was not recorded under the old stored-status model.',
    'Backfilled by migrations/006_derived_track_status.sql during the ' ||
      'switch to derived track status.',
    'open_pivot'
  FROM pivoted
  RETURNING id, track_id
)
UPDATE tracks
SET pivot_decision_id = inserted.id
FROM inserted
WHERE tracks.id = inserted.track_id;

-- Backfill NULL rationale/what_changed on any pre-existing decision rows
-- before validating the NOT NULL check added in step 4 — closes a gap
-- that, per docs/DATABASE_SCHEMA.md, existed only at the tool layer
-- (kt_record_decision always required both as non-empty strings) and
-- never at the DB level, so any row inserted by something other than
-- that tool could have left one NULL.
UPDATE decisions SET rationale = '(rationale not recorded — backfilled by migrations/006_derived_track_status.sql)'
WHERE rationale IS NULL;

-- ============================================================
-- Step 4 (design doc §7): remaining constraints, now that backfill is done
-- ============================================================

-- Ownership: a pivot pointer must reference a decision that (a) belongs
-- to this exact track and (b) actually opened a pivot — not just any
-- decision row. ON DELETE NO ACTION (settled by Paul, 2026-09-08, over a
-- 2-1 panel split — see the final design doc §10): checked at
-- end-of-statement, so a project-level cascade delete (which removes the
-- track and its decisions together) still succeeds in one statement,
-- while a direct delete of a decision anchoring a live pivot is rejected
-- rather than silently clearing it.
ALTER TABLE tracks
  ADD CONSTRAINT tracks_pivot_decision_fk
    FOREIGN KEY (pivot_decision_id, id) REFERENCES decisions (id, track_id)
    ON DELETE NO ACTION;

-- A pivot can be resolved exactly once.
CREATE UNIQUE INDEX decisions_resolves_decision_id_uq
  ON decisions (resolves_decision_id) WHERE resolves_decision_id IS NOT NULL;

-- resolves_decision_id and effect = 'resolve_pivot' come as a pair — set
-- together or not at all (docs/DATABASE_SCHEMA.md's decisions table).
-- A one-directional CHECK here would let a resolve_pivot row through with
-- no resolves_decision_id (nothing to resolve); the app never writes that
-- shape (record-decision.ts only sets resolvesDecisionId when effect is
-- 'resolve_pivot', and always together), so the biconditional the docs
-- already describe just closes the gap for any other writer.
ALTER TABLE decisions
  ADD CONSTRAINT decisions_resolves_requires_effect
    CHECK ((resolves_decision_id IS NOT NULL) = (effect = 'resolve_pivot'));

-- rationale required for every decision from here on — NOT VALID first
-- since existing rows were just backfilled above in the same transaction
-- (validating immediately after backfill, before COMMIT, is cheap at this
-- scale and keeps the constraint fully enforced by the time this
-- migration finishes rather than leaving a NOT VALID constraint that only
-- protects new rows).
ALTER TABLE decisions ADD CONSTRAINT decisions_rationale_not_null
  CHECK (rationale IS NOT NULL) NOT VALID;
ALTER TABLE decisions VALIDATE CONSTRAINT decisions_rationale_not_null;

-- what_changed: required for pivot transitions, optional for plain notes
-- (a plain note may legitimately have nothing to report as "changed").
-- No backfill needed here: kt_record_decision has always required a
-- non-empty what_changed for every call at the tool layer, so no existing
-- row can violate this even before VALIDATE.
ALTER TABLE decisions ADD CONSTRAINT decisions_what_changed_required_for_pivots
  CHECK (effect = 'note' OR what_changed IS NOT NULL) NOT VALID;
ALTER TABLE decisions VALIDATE CONSTRAINT decisions_what_changed_required_for_pivots;

-- Lookup index for "does this track have an active pivot" / "which
-- decision is it" — mirrors idx_tracks_project_id's pattern of indexing
-- what's actually queried.
CREATE INDEX tracks_pivot_decision_id_idx
  ON tracks (pivot_decision_id) WHERE pivot_decision_id IS NOT NULL;

-- ============================================================
-- Step 5 (design doc §7): dependency-cycle prevention trigger
-- ============================================================

-- Defensive, not currently reachable through the v1 tool set alone (a
-- brand-new track can only point at already-existing tracks, never the
-- reverse — docs/DATABASE_SCHEMA.md's track_dependencies notes already
-- call this out), but that's accidental safety, not a guarantee: any
-- future write path that edits dependencies after creation could
-- introduce a multi-hop cycle a plain CHECK constraint cannot see (it can
-- only see the one row being inserted). This trigger closes that gap at
-- the schema level, independent of which application code path performs
-- the insert/update.
CREATE FUNCTION reject_track_dependency_cycle() RETURNS trigger AS $$
DECLARE
  would_cycle boolean;
BEGIN
  -- Would there be a path from NEW.depends_on_track_id back to
  -- NEW.track_id if this edge were added? If so, adding {NEW.track_id ->
  -- NEW.depends_on_track_id} closes a cycle.
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
      USING ERRCODE = '23514'; -- check_violation, consistent with this schema's other invariant-rejection errors
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_track_dependencies_no_cycle
  BEFORE INSERT OR UPDATE ON track_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION reject_track_dependency_cycle();

-- ============================================================
-- Step 6 (design doc §7): the track_readiness view
-- ============================================================

-- Single shared derivation for on_track/blocked/done/pivot_pending plus
-- own_done/effective_done, so there is exactly one place this logic can
-- go wrong, not one per consumer. See the final design doc §3-§4 for the
-- full truth table and the reasoning behind this exact CASE order — it is
-- load-bearing: `NOT dok.ok` (a direct dependency not locally OK) is
-- checked strictly before `own_done`, which is what makes `on_track`
-- provably reachable and prevents a track's own completed items from
-- being reported as `done` over a broken direct dependency.
CREATE VIEW track_readiness AS
WITH RECURSIVE own AS (
  SELECT
    t.id,
    t.project_id,
    (t.pivot_decision_id IS NOT NULL) AS has_pivot,
    (count(i.id) > 0 AND count(i.id) FILTER (WHERE i.status = 'done') = count(i.id))
      AS own_done
  FROM tracks t
  LEFT JOIN items i ON i.track_id = t.id
  GROUP BY t.id, t.project_id, t.pivot_decision_id
),
direct_ok AS (
  -- "Every direct dependency locally OK?" — "locally OK" means that
  -- dependency's own own_done/has_pivot, never its derived status (status
  -- must never read another track's status — see the design doc §3).
  SELECT o.id,
         NOT EXISTS (
           SELECT 1
           FROM track_dependencies d
           JOIN own dd ON dd.id = d.depends_on_track_id
           WHERE d.track_id = o.id
             AND (NOT dd.own_done OR dd.has_pivot)
         ) AS ok
  FROM own o
),
reach (src, dep) AS (
  SELECT d.track_id, d.depends_on_track_id FROM track_dependencies d
  UNION
  SELECT r.src, d.depends_on_track_id
  FROM reach r
  JOIN track_dependencies d ON d.track_id = r.dep
),
transitive_ok AS (
  -- Full transitive walk, same local-facts rule, for effective_done only.
  -- UNION (not UNION ALL) in `reach` above so a cycle in
  -- track_dependencies terminates instead of looping — defensive given
  -- the write-side trigger above already rejects one at insert time.
  SELECT o.id,
         NOT EXISTS (
           SELECT 1
           FROM reach r
           JOIN own dd ON dd.id = r.dep
           WHERE r.src = o.id
             AND (NOT dd.own_done OR dd.has_pivot)
         ) AS ok
  FROM own o
)
SELECT
  o.id,
  o.project_id,
  o.own_done,
  o.has_pivot,
  dok.ok AS direct_deps_ok,
  (o.own_done AND NOT o.has_pivot AND tok.ok) AS effective_done,
  CASE
    WHEN o.has_pivot   THEN 'pivot_pending'
    WHEN NOT dok.ok    THEN 'blocked'
    WHEN o.own_done    THEN 'done'
    ELSE                    'on_track'
  END AS status
FROM own o
JOIN direct_ok dok ON dok.id = o.id
JOIN transitive_ok tok ON tok.id = o.id;

-- ============================================================
-- Step 8 (design doc §7): drop the old stored column
-- ============================================================

-- Application code in this same deploy switches every consumer
-- (kt_get_track, kt_list_tracks, kt_get_project_status, kt_create_track,
-- kt_get_next_steps, kt_render_roadmap) to track_readiness in the same
-- coordinated release — there is no multi-day rollout window here to
-- preserve backward compatibility for, so the column drops in the same
-- migration as the view's creation rather than a later one.
ALTER TABLE tracks DROP COLUMN status;

COMMIT;
