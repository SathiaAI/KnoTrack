-- KnoTrack — 004_adapters_key_version.sql
--
-- Adds the missing column TRD.md §5's "Known gap" bullet calls out:
-- there was no way to tell which generation of KNOTRACK_ENCRYPTION_KEY
-- encrypted a given adapters.encrypted_credential row, so a rotation
-- couldn't distinguish "already rotated" from "still on the old key" —
-- and scripts/rotate-encryption-key.ts (added alongside this migration)
-- needs exactly that to do its job.
--
-- Default 1 on every existing row is correct: every adapter row that
-- exists before this migration runs was encrypted with whatever single
-- key was active at the time (KnoTrack v1 has never supported more than
-- one concurrently-active encryption key), so "1" is simply the current
-- generation's label, not a claim about a specific key value. The
-- rotation script bumps this to 2, 3, ... on each successful rotation.

BEGIN;

ALTER TABLE adapters
  ADD COLUMN key_version integer NOT NULL DEFAULT 1;

COMMIT;
