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
    flag_type: row.kind.toUpperCase(),
    severity: SEVERITY_BY_KIND[row.kind],
    track_id: row.track_id,
    item_id: row.item_id,
    detail: typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail),
    status: row.resolved_at ? 'resolved' : 'open',
    raised_at: row.raised_at,
  };
}

export async function insertDriftFlag(
  db: Queryable,
  input: {
    projectId: string;
    trackId: string | null;
    itemId: string | null;
    kind: DriftKind;
    detail: Record<string, unknown>;
  },
): Promise<DriftFlagRow> {
  const result = await db.query<DriftFlagRow>(
    `INSERT INTO drift_flags (project_id, track_id, item_id, kind, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [input.projectId, input.trackId, input.itemId, input.kind, JSON.stringify(input.detail)],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertDriftFlag: INSERT ... RETURNING produced no row');
  return row;
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

export async function hasOpenFlagForItem(
  db: Queryable,
  itemId: string,
  kind: DriftKind,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM drift_flags WHERE item_id = $1 AND kind = $2 AND resolved_at IS NULL LIMIT 1`,
    [itemId, kind],
  );
  return (result.rowCount ?? 0) > 0;
}

export { toView as driftFlagToView };
