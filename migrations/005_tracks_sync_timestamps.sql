-- KnoTrack — 005_tracks_sync_timestamps.sql
--
-- Adds the two columns docs/TRD.md's Appendix B SYNC_DRIFT rule depends on
-- and which, until now, didn't exist anywhere in the schema
-- (docs/ROADMAP.md T9.x backlog item, decided by Paul 2026-08-25).
--
-- Scoping decision: these columns live on `tracks`, one row per track —
-- NOT on `adapters`. `adapters` has at most one row per (project_id, type)
-- (uq_adapters_project_type, migrations/002), so a project with more than
-- one track syncing through the same adapter would have every track share
-- a single last-synced timestamp: syncing track A would silently make
-- track B look up to date too, which is wrong. A `tracks`-scoped column
-- has no such sharing problem, and a project's github/linear adapter type
-- is already effectively 1:1 with "the" way any of its tracks sync to
-- that service — kt_sync_to_github/kt_sync_to_linear (docs/TRD.md §3.13/
-- §3.14, both still stub registrations as of this migration — src/mcp/
-- tools/stubs.ts) take (project_id, track_id), not an adapter_id, so a
-- track_id+adapter_id join table would add a join with no real second
-- adapter-per-type case to actually join against.
--
-- Nullable, no default: a track that has never been synced (or whose
-- project has no adapter of that type configured) simply has no
-- last-sync timestamp yet — NULL means "never synced", not "synced at
-- epoch". Only a successful ({ok: true}) kt_sync_to_github/
-- kt_sync_to_linear call (once built — T6) is meant to ever write these.
--
-- This migration only adds the columns the schema decision was blocking
-- on; it does not implement kt_sync_to_github/kt_sync_to_linear or the
-- SYNC_DRIFT drift-flag rule itself (both still out of scope — T5/T6
-- haven't started), so building that logic now would be speculative
-- ahead of the tools that populate and consume these columns.

BEGIN;

ALTER TABLE tracks
  ADD COLUMN last_github_sync_at timestamptz,
  ADD COLUMN last_linear_sync_at timestamptz;

COMMIT;
