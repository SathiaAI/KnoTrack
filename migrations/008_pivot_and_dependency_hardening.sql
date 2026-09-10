-- KnoTrack — 008_pivot_and_dependency_hardening.sql
--
-- Bundled follow-up for the three remaining PR #16 escalated findings
-- (project doc "PR #16 escalated findings — frontier panel review",
-- 2026-09-09), approved by Paul on 2026-09-09 ("2. Yes but immediate
-- follow up", "3. Yes", "4. It is urgent and make it part of the next
-- PR as well") to land together as one immediate follow-up PR, stacked
-- on top of PR #16's migration 007:
--
--   Finding 1 — tracks.pivot_decision_id's FK verifies the target
--     decision belongs to the right track, but not that it actually
--     opened a pivot (effect = 'open_pivot').
--   Finding 2 (full fix) — migration 007 closed the same-track half of
--     decisions.resolves_decision_id's gap; this closes the remaining
--     effect-typed half (the target must be effect = 'open_pivot').
--   Finding 3 — track_dependencies has no schema-level project-scoping:
--     nothing before this migration stopped an edge from crossing
--     project boundaries except kt_create_track's application code.
--   Finding 4 — the cycle-prevention trigger has a snapshot-isolation
--     race (two concurrent inserts can jointly form a cycle neither one
--     individually appears to close) and, per Fable's independent
--     reasoning trace surfaced during the panel review, a false-positive
--     bug on its own UPDATE path (correcting an edge A->B to B->A can be
--     rejected as a "cycle" because the reachability check still sees
--     the pre-update A->B row).
--
-- ============================================================
-- A correction to this migration's own design brief, found during
-- implementation, not during review
-- ============================================================
--
-- The project doc's proposed fix for finding 2 specified declaring the
-- new composite FK as MATCH FULL, reasoning that "a plain note/open_pivot
-- decision (resolves_decision_id and resolves_target_effect both NULL)
-- still skips the check regardless of track_id." That reasoning is
-- wrong, verified empirically against a live Postgres instance while
-- building this migration: MATCH FULL's actual rule is "no row may mix
-- NULL and non-NULL key columns" — not "skip only if every column is
-- NULL, else require all non-NULL." An ordinary decisions row (the
-- overwhelming majority of the table) has effect = 'note',
-- resolves_decision_id/resolves_target_effect both NULL, and a
-- perfectly normal non-NULL track_id — exactly the "mixed" shape MATCH
-- FULL rejects outright, regardless of whether a matching parent row
-- exists. Declaring this FK MATCH FULL as originally proposed would have
-- made every ordinary note/open_pivot decision with a track_id
-- uninsertable. (Reproduced directly: see the CI-visible test run in
-- this PR's description, or re-run `SELECT ... MATCH FULL ...` against a
-- two-column parent/child pair with one populated, two NULL columns —
-- Postgres raises "MATCH FULL does not allow mixing of null and nonnull
-- key values.")
--
-- The corrected fix keeps the default MATCH SIMPLE (skip the check if
-- *any* referencing column is NULL — safe here because resolves_decision_id
-- is NULL for every non-resolving decision, which is what triggers the
-- skip) and closes Astra's real underlying concern — a resolve_pivot row
-- with a NULL track_id bypassing the FK under MATCH SIMPLE — with a
-- narrow rule instead: track_id must be non-NULL whenever effect <> 'note'.
-- That was already true of every row kt_record_decision has ever written;
-- this just makes the database refuse any future writer that tries to
-- violate it, without touching the unrelated, legitimate nullable-track_id
-- feature for plain project-level notes.
--
-- A second correction, found by Codex's automated review of this same PR
-- (not by the original panel or by manual testing): the first draft of
-- this migration enforced that rule with a plain CHECK constraint
-- (`decisions_track_id_required_for_pivots CHECK (effect = 'note' OR
-- track_id IS NOT NULL)`). A CHECK constraint re-validates on *every*
-- row modification, not just INSERT — including the row modification
-- `decisions.track_id ... ON DELETE SET NULL` (migrations/001_init.sql)
-- performs automatically when a track is deleted. `docs/DATABASE_SCHEMA.md`
-- documents this SET NULL as the mechanism a hard project delete or a
-- GDPR-style legal-erasure operation relies on to preserve decision
-- history after the track itself is gone. A CHECK constraint would reject
-- that exact SET NULL for any decision that ever recorded an
-- `open_pivot`/`resolve_pivot`, breaking the documented erasure path —
-- reproduced directly against a live database while responding to this
-- finding (`DELETE FROM tracks ...` on a track with an `open_pivot`
-- decision raised `violates check constraint
-- "decisions_track_id_required_for_pivots"`).
--
-- The fix is a `BEFORE INSERT` (not `INSERT OR UPDATE`) trigger instead:
-- `kt_record_decision` is the only path that ever writes a `decisions`
-- row (`docs/PRD.md` §5.2: the codebase never issues `UPDATE`/`DELETE`
-- against `decisions` at the application layer — it's append-only by
-- convention), so a trigger that only fires on INSERT closes Astra's gap
-- exactly where it can occur while leaving the FK-cascade's own internal
-- UPDATE untouched. Verified against a live database: a malformed fresh
-- INSERT is still rejected, and the hard-delete cascade now succeeds.
--
-- ============================================================

BEGIN;

-- ============================================================
-- Finding 1 + Finding 2: shared unique key backing both effect-typed
-- composite FKs below.
-- ============================================================

ALTER TABLE decisions
  ADD CONSTRAINT decisions_id_track_effect_key UNIQUE (id, track_id, effect);

-- ============================================================
-- Finding 1: tracks.pivot_decision_id must reference a decision that
-- both belongs to this track AND actually opened a pivot.
-- ============================================================

-- tracks.id is the table's PK (always non-NULL) and pivot_effect is a
-- constant generated column (always non-NULL), so the only nullable
-- column in this three-column FK is pivot_decision_id itself — MATCH
-- SIMPLE's "skip if any column is NULL" behavior therefore only ever
-- triggers on "no active pivot," never on a partially-populated row.
-- No MATCH FULL needed here (unlike finding 2, this FK has no
-- independently-nullable non-key column to create a mixed-NULL case).
ALTER TABLE tracks
  ADD COLUMN pivot_effect text GENERATED ALWAYS AS ('open_pivot') STORED;

ALTER TABLE tracks DROP CONSTRAINT tracks_pivot_decision_fk;
ALTER TABLE tracks
  ADD CONSTRAINT tracks_pivot_decision_fk
    FOREIGN KEY (pivot_decision_id, id, pivot_effect)
    REFERENCES decisions (id, track_id, effect)
    ON DELETE NO ACTION;

-- ============================================================
-- Finding 2 (full fix): decisions.resolves_decision_id must reference a
-- decision that both belongs to the same track (migration 007) AND
-- actually opened a pivot (effect = 'open_pivot').
-- ============================================================

-- Closes the actual gap Astra identified (a resolve_pivot row with a
-- NULL track_id bypassing the composite FK under MATCH SIMPLE) without
-- the MATCH FULL approach's fatal side effect documented above. A BEFORE
-- INSERT trigger, not a CHECK constraint — see this file's header
-- comment for why a CHECK here would break the documented
-- track-hard-delete/legal-erasure path (decisions.track_id ... ON DELETE
-- SET NULL). kt_record_decision is the only path that ever writes a
-- decisions row, and always sets track_id for every non-'note' decision,
-- so this never rejects a legitimate write.
CREATE FUNCTION reject_pivot_decision_without_track() RETURNS trigger AS $$
BEGIN
  IF NEW.effect <> 'note' AND NEW.track_id IS NULL THEN
    RAISE EXCEPTION
      'decisions: effect=% requires a non-NULL track_id (id=%)', NEW.effect, NEW.id
      USING ERRCODE = '23514'; -- check_violation, consistent with this schema's other invariant-rejection errors
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_decisions_track_id_required_for_pivots
  BEFORE INSERT ON decisions
  FOR EACH ROW
  EXECUTE FUNCTION reject_pivot_decision_without_track();

ALTER TABLE decisions
  ADD COLUMN resolves_target_effect text
    GENERATED ALWAYS AS (CASE WHEN resolves_decision_id IS NOT NULL THEN 'open_pivot' END) STORED;

-- Superseded by the three-column FK below, which verifies same-track
-- AND effect = 'open_pivot' — a strict superset of migration 007's
-- same-track-only check.
ALTER TABLE decisions DROP CONSTRAINT decisions_resolves_same_track_fk;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_resolves_open_pivot_fk
    FOREIGN KEY (resolves_decision_id, track_id, resolves_target_effect)
    REFERENCES decisions (id, track_id, effect);

-- ============================================================
-- Finding 3: track_dependencies has no schema-level project scoping.
-- ============================================================

ALTER TABLE tracks ADD CONSTRAINT tracks_id_project_key UNIQUE (id, project_id);

ALTER TABLE track_dependencies ADD COLUMN project_id uuid;

-- Backfill from the existing track_id -> tracks.project_id relationship.
-- Every existing edge is same-project today (kt_create_track's
-- application-layer check, create-track.ts, has always enforced this;
-- this migration is what makes it a schema-level guarantee going
-- forward), so this backfill cannot produce a value the FKs below would
-- reject.
UPDATE track_dependencies td
SET project_id = t.project_id
FROM tracks t
WHERE t.id = td.track_id;

ALTER TABLE track_dependencies ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE track_dependencies
  ADD CONSTRAINT td_track_same_project
    FOREIGN KEY (track_id, project_id) REFERENCES tracks (id, project_id),
  ADD CONSTRAINT td_dep_same_project
    FOREIGN KEY (depends_on_track_id, project_id) REFERENCES tracks (id, project_id);

-- ============================================================
-- Finding 4: close the cycle-prevention trigger's snapshot-isolation
-- race and its UPDATE-path false-positive bug, in the same pass (Paul,
-- 2026-09-09: elevated to urgent, bundled into this PR rather than
-- deferred to whatever future tool would have made it reachable).
-- ============================================================

-- Must come after finding 3 above: this function now reads NEW.project_id
-- directly off the track_dependencies row rather than joining to tracks.
CREATE OR REPLACE FUNCTION reject_track_dependency_cycle() RETURNS trigger AS $$
DECLARE
  would_cycle boolean;
BEGIN
  -- Serialize all dependency-graph mutations within one project behind a
  -- single advisory lock, scoped by project so unrelated projects never
  -- contend. Closes the race where two concurrent inserts, each
  -- individually reachability-clean under READ COMMITTED, could jointly
  -- close a cycle once both commit (verified against the panel's
  -- analysis; not reachable through any tool this PR or its predecessor
  -- ship, but a hard prerequisite for the next one that edits existing
  -- edges). Held for the rest of this transaction, released automatically
  -- at COMMIT/ROLLBACK — never needs an explicit unlock.
  --
  -- Scope of this guarantee (raised by Codex's automated review of this
  -- PR): this lock closes the race for READ COMMITTED writers only — the
  -- isolation level `src/db/tx.ts`'s `withTransaction` uses, and the only
  -- one any write path in this codebase ever uses against
  -- track_dependencies (`withReadSnapshot`'s REPEATABLE READ transactions
  -- are READ ONLY, so they can never reach this trigger). Advisory locks
  -- block execution order but do not affect MVCC snapshot visibility: a
  -- REPEATABLE READ writer's reachability query would still run against
  -- the snapshot taken at its transaction's start, so it could remain
  -- blind to a concurrently-committed edge even after this lock releases.
  -- (A SERIALIZABLE writer would not have this gap — Postgres's own
  -- serializable-snapshot-isolation machinery independently detects this
  -- exact write-skew pattern and aborts one transaction with SQLSTATE
  -- 40001 — but SERIALIZABLE is not in use here either.) Not fixed here:
  -- doing so would mean adding isolation-level enforcement or a retry
  -- protocol against a writer that does not exist in this codebase today
  -- — deferred until a real REPEATABLE READ/SERIALIZABLE writer against
  -- this table is actually proposed.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.project_id::text));

  -- Would there be a path from NEW.depends_on_track_id back to
  -- NEW.track_id if this edge were added? If so, adding {NEW.track_id ->
  -- NEW.depends_on_track_id} closes a cycle.
  --
  -- On UPDATE, the row being modified is excluded from the walk: a
  -- BEFORE UPDATE trigger fires before this row's own change is applied,
  -- so a plain query against track_dependencies still sees this row's
  -- OLD value. Without this exclusion, correcting an edge A->B to B->A
  -- would see the stale A->B edge still "in" the graph while checking
  -- whether B->A closes a cycle, and reject a legitimate correction as a
  -- false positive (found in Fable's reasoning trace during the panel
  -- review; reproduced and the fix verified against a live database
  -- while building this migration).
  WITH RECURSIVE reach(node) AS (
    SELECT NEW.depends_on_track_id
    UNION
    SELECT td.depends_on_track_id
    FROM track_dependencies td
    JOIN reach r ON td.track_id = r.node
    WHERE NOT (
      TG_OP = 'UPDATE'
      AND td.track_id = OLD.track_id
      AND td.depends_on_track_id = OLD.depends_on_track_id
    )
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

COMMIT;
