// `drift_flags` access.
//
// Schema note: TRD §3.12/Appendix C describe six `flag_type` values plus
// a `severity` and a `status` ('open'/'resolved'/'dismissed') column. The
// authoritative, already-applied migration (migrations/001_init.sql) has
// a `kind` column restricted by CHECK to exactly two values
// ('out_of_sequence', 'orphan_file_change'), no `severity` column, and
// "open" is represented by `resolved_at IS NULL` rather than a status
// enum. This module maps onto the real columns:
//   - `flag_type` in tool output = `kind` (upper-cased, TRD-style)
//   - `severity` is derived from a fixed kind -> severity table, since
//     the DB doesn't store one
//   - `status` in tool output = 'open' when resolved_at IS NULL, else
//     'resolved'
// kt_check_drift itself (which would run the full six-rule catalog) is
// out of scope for this build (stub only, see src/mcp/tools/check-drift.ts)
// — only the two DB-representable kinds are ever written here, by
// kt_record_session_summary's scoped re-check.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type DriftKind = 'out_of_sequence' | 'orphan_file_change';

const SEVERITY_BY_KIND: Record<DriftKind, 'info' | 'warning' | 'critical'> = {
  out_of_sequence: 'info',
  orphan_file_change: 'warning',
};

// adversarial-review P1: `row.kind.toUpperCase()` produced 'OUT_OF_SEQUENCE'
// for the DB kind, but TRD Appendix C names this public flag_type
// 'SEQUENCE_SKIP' (see this module's header comment) — a client switching
// on flag_type by the documented name could never match it. An explicit
// per-kind mapping (rather than a string transform) makes the public name
// independent of the DB's internal spelling, and a missing case is a
// compile error instead of a silently-wrong uppercase guess.
const PUBLIC_FLAG_TYPE_BY_KIND: Record<DriftKind, string> = {
  out_of_sequence: 'SEQUENCE_SKIP',
  // No TRD Appendix C flag_type corresponds to this DB kind — it isn't
  // raised anywhere in this build (reserved for kt_check_drift's future
  // orphan-file-change rule, out of scope here). Kept as a distinct,
  // clearly-DB-shaped name rather than silently aliased to one of the six
  // real flag_types it doesn't actually mean.
  orphan_file_change: 'ORPHAN_FILE_CHANGE',
};

export interface DriftFlagRow {
  id: string;
  project_id: string;
  track_id: string | null;
  item_id: string | null;
  kind: DriftKind;
  detail: Record<string, unknown>;
  raised_at: Date;
  resolved_at: Date | null;
}

export interface DriftFlagView {
  flag_id: string;
  flag_type: string;
  severity: 'info' | 'warning' | 'critical';
  track_id: string | null;
  item_id: string | null;
  detail: string;
  status: 'open' | 'resolved';
  raised_at: Date;
}

function toView(row: DriftFlagRow): DriftFlagView {
  return {
    flag_id: row.id,
    flag_type: PUBLIC_FLAG_TYPE_BY_KIND[row.kind],
    severity: SEVERITY_BY_KIND[row.kind],
    track_id: row.track_id,
    item_id: row.item_id,
    detail: typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail),
    status: row.resolved_at ? 'resolved' : 'open',
    raised_at: row.raised_at,
  };
}

/**
 * Raises a new open flag for (item_id, kind) unless one is already open,
 * atomically. Returns the inserted row, or `null` when an open flag for
 * this (item_id, kind) already existed (nothing inserted).
 *
 * adversarial-review P1: this used to be a separate `hasOpenFlagForItem`
 * check followed by a plain `INSERT` — two concurrent
 * kt_record_session_summary calls scanning the same out-of-sequence item
 * could both observe "not open yet" and both insert, producing duplicate
 * open flags for the same item. `ON CONFLICT ... DO NOTHING` against the
 * `uq_drift_flags_open_item_kind` partial unique index (migrations/003)
 * makes this check-and-insert atomic at the database level: at most one of
 * two concurrent callers ever gets a row back.
 */
export async function insertDriftFlagIfNotOpen(
  db: Queryable,
  input: {
    projectId: string;
    trackId: string | null;
    itemId: string | null;
    kind: DriftKind;
    detail: Record<string, unknown>;
  },
): Promise<DriftFlagRow | null> {
  const result = await db.query<DriftFlagRow>(
    `INSERT INTO drift_flags (project_id, track_id, item_id, kind, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (item_id, kind) WHERE resolved_at IS NULL
     DO NOTHING
     RETURNING *`,
    [input.projectId, input.trackId, input.itemId, input.kind, JSON.stringify(input.detail)],
  );
  return result.rows[0] ?? null;
}

export async function listOpenDriftFlags(
  db: Queryable,
  projectId: string,
  limit: number,
): Promise<DriftFlagView[]> {
  const result = await db.query<DriftFlagRow>(
    `SELECT * FROM drift_flags
     WHERE project_id = $1 AND resolved_at IS NULL
     ORDER BY raised_at DESC
     LIMIT $2`,
    [projectId, limit],
  );
  return result.rows.map(toView);
}

/** Open flags of one kind, scoped to a track — used by the scoped
 * re-check to know which items currently have an open flag, both to skip
 * re-raising for them and to resolve the ones whose condition cleared. */
export async function listOpenFlagsForTrack(
  db: Queryable,
  trackId: string,
  kind: DriftKind,
): Promise<DriftFlagRow[]> {
  const result = await db.query<DriftFlagRow>(
    `SELECT * FROM drift_flags WHERE track_id = $1 AND kind = $2 AND resolved_at IS NULL`,
    [trackId, kind],
  );
  return result.rows;
}

/**
 * Marks the given flags resolved (sets resolved_at = now()). No-op for an
 * empty list.
 *
 * adversarial-review P1: nothing anywhere ever wrote `resolved_at` — once
 * an item's out-of-sequence condition cleared (the earlier item was also
 * finished), its flag stayed open indefinitely and kt_get_project_status
 * kept reporting it. Called by the scoped re-check with exactly the open
 * flags whose item is no longer among the current findings.
 */
export async function resolveDriftFlags(db: Queryable, flagIds: string[]): Promise<void> {
  if (flagIds.length === 0) return;
  await db.query(
    `UPDATE drift_flags SET resolved_at = now() WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL`,
    [flagIds],
  );
}

export { toView as driftFlagToView };
