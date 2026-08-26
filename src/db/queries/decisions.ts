import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface DecisionRow {
  id: string;
  project_id: string;
  track_id: string | null;
  title: string;
  rationale: string | null;
  what_changed: string | null;
  created_at: Date;
}

/** kt_record_decision (TRD §3.10). `decisions` is append-only (no
 * `updated_at`, same convention as `events` — see migrations/001_init.sql's
 * header comment), so this is the only write this file ever needs. */
export async function insertDecision(
  db: Queryable,
  input: {
    projectId: string;
    trackId: string;
    title: string;
    rationale: string;
    whatChanged: string;
  },
): Promise<DecisionRow> {
  const result = await db.query<DecisionRow>(
    `INSERT INTO decisions (project_id, track_id, title, rationale, what_changed)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.projectId, input.trackId, input.title, input.rationale, input.whatChanged],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertDecision: INSERT ... RETURNING produced no row');
  return row;
}
