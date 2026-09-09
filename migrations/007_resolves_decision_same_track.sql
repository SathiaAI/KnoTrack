-- KnoTrack — 007_resolves_decision_same_track.sql
--
-- PR #16 escalated finding 2 (frontier-panel review, see project doc
-- "PR #16 escalated findings — frontier panel review", 2026-09-09):
-- `decisions.resolves_decision_id` had no database-level check that the
-- decision it points at belongs to the *same track*. Nothing in
-- migration 006 stopped `resolves_decision_id` from pointing at a
-- decision on a different track (or a different project entirely) — the
-- only existing constraint, `decisions_resolves_decision_id_uq`, just
-- guarantees a target decision is resolved at most once globally, and
-- says nothing about what it resolves.
--
-- This is the minimal, same-track half of that finding's fix (Paul,
-- 2026-09-09: "Yes" to landing this in the current PR). It reuses the
-- `decisions_id_track_id_key UNIQUE (id, track_id)` constraint migration
-- 006 already added for `tracks.pivot_decision_id`'s FK, applying the
-- identical pattern to the other direction that migration missed.
--
-- The full fix — verifying the target also has effect = 'open_pivot',
-- via a generated-column composite FK with MATCH FULL — is a separate,
-- immediate follow-up migration (008), since it introduces a new
-- generated column and shares that column's unique constraint with
-- finding 1's fix; bundling it here would make this PR's change
-- non-minimal for no benefit given nothing in the current PR touches
-- that column.
--
-- No backfill/NOT VALID needed: `kt_record_decision` (the only write
-- path for `resolves_decision_id`) always sets `track_id` to the same
-- track as the pivot being resolved, so no existing row can violate this.

BEGIN;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_resolves_same_track_fk
    FOREIGN KEY (resolves_decision_id, track_id)
    REFERENCES decisions (id, track_id);

COMMIT;
