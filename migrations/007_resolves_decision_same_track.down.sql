-- KnoTrack — 007_resolves_decision_same_track.down.sql
-- Reverse of 007_resolves_decision_same_track.sql.

BEGIN;

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_resolves_same_track_fk;

COMMIT;
