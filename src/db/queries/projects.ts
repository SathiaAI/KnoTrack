import type { Pool, PoolClient } from 'pg';

export interface ProjectRow {
  id: string;
  name: string;
  source_type: 'github' | 'linear' | 'local';
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

type Queryable = Pool | PoolClient;

export async function findActiveProjectById(
  db: Queryable,
  projectId: string,
): Promise<ProjectRow | null> {
  const result = await db.query<ProjectRow>(
    `SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomic upsert on (source_type, source_ref) via the `uq_projects_source_ref_active`
 * partial unique index (migrations/002). Replaces the previous find-then-insert
 * pattern, which had a TOCTOU race under concurrent calls with the same source
 * identity (adversarial-review correctness-3) — two concurrent callers could
 * both miss an existing row and both insert, producing duplicate projects.
 * `INSERT ... ON CONFLICT ... DO UPDATE` resolves the race atomically at the
 * database level: exactly one row ever exists per (source_type, source_ref)
 * among non-soft-deleted projects, and the second concurrent caller updates
 * the same row the first one created instead of erroring or duplicating.
 */
export async function upsertProjectBySourceRef(
  db: Queryable,
  input: { name: string; sourceType: string; sourceRef: string },
): Promise<ProjectRow> {
  const result = await db.query<ProjectRow>(
    `INSERT INTO projects (name, source_type, source_ref)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_type, source_ref) WHERE deleted_at IS NULL
     DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [input.name, input.sourceType, input.sourceRef],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('upsertProjectBySourceRef: INSERT ... RETURNING produced no row');
  }
  return row;
}
