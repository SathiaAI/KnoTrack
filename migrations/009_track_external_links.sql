-- ============================================================
-- track_external_links  (docs/ROADMAP.md T5.2 / docs/PRD.md §4.13)
-- ============================================================
-- Durable link between a KnoTrack track and the external issue it is
-- synced to (GitHub in T5.2, Linear in T5.3 via the same table). This is
-- the AUTHORITATIVE idempotency store for kt_sync_to_github: the tool
-- decides create-vs-update from a row here, never from an eventually-
-- consistent GitHub search (design panel 2026-09-19, unanimous Option A).
--
-- sync_state carries a durable creation-intent so a crash *between*
-- GitHub accepting a create (HTTP 201) and this row being finalized never
-- silently produces a duplicate issue on the next sync:
--   'pending' — a creation attempt was durably claimed (committed) BEFORE
--               the outbound POST. If the process dies mid-flight the row
--               stays 'pending'; the next sync sees it, refuses to blindly
--               POST again, and routes to explicit marker-based recovery.
--   'linked'  — a real issue exists; external_id/url/content_hash are set.
--
-- external_id is the repo-scoped GitHub *issue number* (PATCH needs the
-- number, not the URL). repo_identity binds the link to the exact
-- owner/repo it was created against, so a later silent change to the
-- adapter's configured repo cannot update an unrelated issue.
-- operation_id lets a stale completion be detected and rejected rather
-- than overwriting a newer result.

BEGIN;

CREATE TABLE track_external_links (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id      uuid        NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  adapter_type  text        NOT NULL CHECK (adapter_type IN ('github', 'linear')),
  sync_state    text        NOT NULL CHECK (sync_state IN ('pending', 'linked')),
  external_id   text,
  external_url  text,
  repo_identity text        NOT NULL,
  content_hash  text,
  operation_id  uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- at most one link of a given adapter type per track; this UNIQUE is the
  -- real cross-process guard against two concurrent syncs both creating an
  -- issue (INSERT ... ON CONFLICT DO NOTHING claims the slot atomically).
  CONSTRAINT uq_track_external_links_track_type UNIQUE (track_id, adapter_type),
  -- a linked row must carry its full identity; a pending row need not.
  CONSTRAINT ck_track_external_links_linked_complete CHECK (
    sync_state <> 'linked'
    OR (external_id IS NOT NULL AND external_url IS NOT NULL AND content_hash IS NOT NULL)
  )
);

-- lookups that resolve "which track owns issue #N" during recovery.
CREATE INDEX idx_track_external_links_external_id
  ON track_external_links (external_id);

CREATE TRIGGER trg_track_external_links_set_updated_at
  BEFORE UPDATE ON track_external_links
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

COMMIT;
