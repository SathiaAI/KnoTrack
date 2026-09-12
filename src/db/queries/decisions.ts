import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type DecisionEffect = 'note' | 'open_pivot' | 'resolve_pivot';

export interface DecisionRow {
  id: string;
  project_id: string;
  track_id: string | null;
  title: string;
  rationale: string | null;
  what_changed: string | null;
  effect: DecisionEffect;
  resolves_decision_id: string | null;
  created_at: Date;
}

/** kt_record_decision (TRD §3.10). `decisions` is append-only (no
 * `updated_at`, same convention as `events` — see migrations/001_init.sql's
 * header comment), so this is the only write this file ever needs.
 *
 * `effect` (T2.16, migrations/006_derived_track_status.sql) records
 * whether this decision is a plain note, opens a pivot, or resolves one —
 * see record-decision.ts for the transaction shape that pairs an
 * 'open_pivot'/'resolve_pivot' insert with the matching
 * openTrackPivot/resolveTrackPivot compare-and-set update on `tracks`. */
export async function insertDecision(
  db: Queryable,
  input: {
    projectId: string;
    trackId: string;
    title: string;
    rationale: string;
    whatChanged: string;
    effect: DecisionEffect;
    resolvesDecisionId?: string;
  },
): Promise<DecisionRow> {
  const result = await db.query<DecisionRow>(
    `INSERT INTO decisions (project_id, track_id, title, rationale, what_changed, effect, resolves_decision_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.projectId,
      input.trackId,
      input.title,
      input.rationale,
      input.whatChanged,
      input.effect,
      input.resolvesDecisionId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertDecision: INSERT ... RETURNING produced no row');
  return row;
}
