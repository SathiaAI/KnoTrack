-- KnoTrack — 002_projects_unique_source_ref.sql
--
-- Fixes adversarial-review finding correctness-3: registerProjectService's
-- upsert (find-then-insert, both inside one transaction) had no database
-- constraint backing the documented "(source_type, source_ref) is unique;
-- calling kt_register_project again with the same pair updates the
-- existing row, never creates a duplicate" invariant (docs/TRD.md §3.2).
-- Two concurrent first-registrations of the same source_ref could both
-- pass the SELECT check and both INSERT, producing two projects with the
-- same source identity.
--
-- A partial unique index (scoped to non-soft-deleted rows, matching every
-- other "active project" lookup in this schema) turns that race into a
-- database-enforced constraint: the second concurrent INSERT now fails
-- with a 23505 unique-violation instead of silently succeeding. See the
-- corresponding change in src/db/queries/projects.ts, which turns
-- insertProject into an atomic `INSERT ... ON CONFLICT ... DO UPDATE`
-- targeting this exact index, so the race resolves to the documented
-- upsert behavior instead of an unhandled error.
--
-- source_ref is nullable (source_type='local' projects have no natural
-- external ref) — Postgres unique indexes treat NULLs as distinct from
-- each other, so multiple local projects with source_ref IS NULL remain
-- unaffected by this constraint, which is the correct behavior.

BEGIN;

CREATE UNIQUE INDEX uq_projects_source_ref_active
  ON projects (source_type, source_ref)
  WHERE deleted_at IS NULL;

COMMIT;
