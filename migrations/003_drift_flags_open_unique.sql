-- KnoTrack — 003_drift_flags_open_unique.sql
--
-- Fixes adversarial-review finding: kt_record_session_summary's scoped
-- drift re-check (src/mcp/tools/record-session-summary.ts) used to decide
-- whether to raise a new flag with a plain check-then-insert
-- (hasOpenFlagForItem, then insertDriftFlag) — no database constraint
-- backed the "at most one open flag per (item_id, kind)" invariant the
-- rest of the system assumes. Two concurrent kt_record_session_summary
-- calls scanning the same out-of-sequence item could both observe
-- alreadyOpen === false and both insert an open flag for it.
--
-- A partial unique index (scoped to open flags — resolved_at IS NULL —
-- matching this schema's existing convention for "active row" partial
-- indexes, e.g. migrations/002's uq_projects_source_ref_active) turns
-- that race into a database-enforced constraint: the second concurrent
-- INSERT now conflicts instead of silently succeeding. See the
-- corresponding change in src/db/queries/drift-flags.ts, which turns the
-- check-then-insert into an atomic `INSERT ... ON CONFLICT ... DO NOTHING`
-- targeting this exact index.
--
-- item_id is nullable (drift_flags.item_id references items ON DELETE SET
-- NULL) — Postgres unique indexes treat NULLs as distinct from each other,
-- so multiple resolved-at-null rows with item_id IS NULL would remain
-- unaffected by this constraint. That's fine: every kind this build ever
-- raises ('out_of_sequence', via the only insert call site) always sets
-- item_id, so this index does cover the real invariant it's meant to.

BEGIN;

CREATE UNIQUE INDEX uq_drift_flags_open_item_kind
  ON drift_flags (item_id, kind)
  WHERE resolved_at IS NULL;

COMMIT;
