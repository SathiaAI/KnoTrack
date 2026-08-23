-- KnoTrack — 001_init.sql
-- Initial schema migration. Plain SQL, runnable as a node-pg-migrate
-- raw-SQL migration (node-pg-migrate --migrations-dir migrations, with
-- a migration named 001_init.sql / 001_init.down.sql pair auto-detected
-- as the up/down halves of migration 001_init).
--
-- Design choices are explained in ../docs/DATABASE_SCHEMA.md. Summary:
--   * All enumerated fields use `text` + `CHECK (... IN (...))`, not
--     native Postgres `CREATE TYPE ... AS ENUM`. See "Enum vs text+CHECK"
--     in the doc for the justification. This choice is applied
--     consistently across every status/type/kind column below.
--   * Every project-owned child table cascades on project delete at the
--     FK level, but KnoTrack never issues that DELETE from the
--     application in normal operation — projects are soft-deleted via
--     `projects.deleted_at` to preserve the Event/Decision audit trail.
--     See "Soft delete vs hard delete" in the doc.
--   * uuid primary keys are generated with gen_random_uuid() from
--     pgcrypto, which is broadly available (built-in or via extension)
--     across supported Postgres versions (13+).

BEGIN;

-- ============================================================
-- Extensions
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Shared trigger function: keep updated_at current on UPDATE
-- ============================================================

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- projects
-- ============================================================

CREATE TABLE projects (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  source_type  text        NOT NULL CHECK (source_type IN ('github', 'linear', 'local')),
  source_ref   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE TRIGGER trg_projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Hot path: "list my active projects" / most lookups exclude soft-deleted rows.
CREATE INDEX idx_projects_not_deleted ON projects (id) WHERE deleted_at IS NULL;

-- ============================================================
-- adapters
-- ============================================================

CREATE TABLE adapters (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  type                  text        NOT NULL CHECK (type IN ('github', 'linear')),
  encrypted_credential  bytea       NOT NULL,
  config                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- at most one adapter of a given type per project
  CONSTRAINT uq_adapters_project_type UNIQUE (project_id, type)
);

CREATE INDEX idx_adapters_project_id ON adapters (project_id);

-- ============================================================
-- tracks
-- ============================================================

CREATE TABLE tracks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title           text        NOT NULL,
  status          text        NOT NULL DEFAULT 'on_track'
                    CHECK (status IN ('on_track', 'pivot_pending', 'blocked', 'done')),
  source_doc_ref  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tracks_set_updated_at
  BEFORE UPDATE ON tracks
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_tracks_project_id ON tracks (project_id);

-- ============================================================
-- track_dependencies (track A depends on track B)
-- ============================================================

CREATE TABLE track_dependencies (
  track_id            uuid NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  depends_on_track_id uuid NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (track_id, depends_on_track_id),
  CONSTRAINT ck_track_dependencies_no_self_dep CHECK (track_id <> depends_on_track_id)
);

-- Reverse-lookup index: "which tracks depend on this one" (e.g. for
-- cascading pivot/blocked status or cycle-detection walks).
CREATE INDEX idx_track_dependencies_depends_on ON track_dependencies (depends_on_track_id);

-- ============================================================
-- items
-- ============================================================

CREATE TABLE items (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id           uuid        NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  title              text        NOT NULL,
  sequence_position  integer     NOT NULL,
  status             text        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'in_progress', 'done', 'blocked')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_items_set_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_items_track_id ON items (track_id);
-- Ordered-fetch hot path: "give me this track's items in sequence".
CREATE INDEX idx_items_track_id_sequence_position ON items (track_id, sequence_position);

-- ============================================================
-- item_dependencies (item A depends on item B)
-- ============================================================

CREATE TABLE item_dependencies (
  item_id            uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  depends_on_item_id uuid NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, depends_on_item_id),
  CONSTRAINT ck_item_dependencies_no_self_dep CHECK (item_id <> depends_on_item_id)
);

CREATE INDEX idx_item_dependencies_depends_on ON item_dependencies (depends_on_item_id);

-- ============================================================
-- events (append-only audit trail)
-- ============================================================

CREATE TABLE events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  track_id       uuid        REFERENCES tracks (id) ON DELETE SET NULL,
  summary_text   text        NOT NULL,
  files_touched  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  items_touched  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
  -- No updated_at column, deliberately: events are append-only. See the
  -- "Append-only tables" note in the schema doc for the REVOKE UPDATE
  -- suggestion for locked-down deployments.
);

CREATE INDEX idx_events_project_id ON events (project_id);
CREATE INDEX idx_events_track_id ON events (track_id);

-- ============================================================
-- decisions (append-only audit trail)
-- ============================================================

CREATE TABLE decisions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  track_id      uuid        REFERENCES tracks (id) ON DELETE SET NULL,
  title         text        NOT NULL,
  rationale     text,
  what_changed  text,
  created_at    timestamptz NOT NULL DEFAULT now()
  -- Append-only, same convention as events. No updated_at.
);

CREATE INDEX idx_decisions_project_id ON decisions (project_id);
CREATE INDEX idx_decisions_track_id ON decisions (track_id);

-- ============================================================
-- api_tokens
-- ============================================================

CREATE TABLE api_tokens (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        REFERENCES projects (id) ON DELETE CASCADE,
  token_hash    text        NOT NULL,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  -- project_id is nullable: NULL means a server-wide token (not scoped
  -- to a single project); non-null means a project-scoped token.
  CONSTRAINT uq_api_tokens_token_hash UNIQUE (token_hash)
);

-- Bearer-auth hot path: every authenticated request looks up by hash.
-- (uq_api_tokens_token_hash above already creates a unique index that
-- serves this lookup; project_id is indexed separately for the
-- "list tokens for a project" admin view.)
CREATE INDEX idx_api_tokens_project_id ON api_tokens (project_id);

-- ============================================================
-- drift_flags
-- ============================================================

CREATE TABLE drift_flags (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  track_id     uuid        REFERENCES tracks (id) ON DELETE SET NULL,
  item_id      uuid        REFERENCES items (id) ON DELETE SET NULL,
  kind         text        NOT NULL CHECK (kind IN ('out_of_sequence', 'orphan_file_change')),
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  raised_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX idx_drift_flags_project_id ON drift_flags (project_id);
CREATE INDEX idx_drift_flags_track_id ON drift_flags (track_id);
CREATE INDEX idx_drift_flags_item_id ON drift_flags (item_id);

-- Hot path for kt_get_project_status: "open drift flags for this
-- project". Partial index keeps it small and fast as resolved flags
-- accumulate over the project's lifetime.
CREATE INDEX idx_drift_flags_open_by_project ON drift_flags (project_id) WHERE resolved_at IS NULL;

-- ============================================================
-- Locked-down deployment hardening (optional, NOT executed here)
-- ============================================================
-- KnoTrack's application code never UPDATEs events or decisions rows.
-- For a deployment that wants this enforced at the database level
-- rather than by convention, run something like the following against
-- the role your application connects as (substitute the real role
-- name — this is commented out because the role does not exist by
-- default and the statement would fail the migration otherwise):
--
--   REVOKE UPDATE ON events, decisions FROM knotrack_app;
--
-- INSERT and SELECT remain granted; only UPDATE is revoked, so the
-- append-only invariant is enforced by the database, not just by the
-- application layer.

COMMIT;
