import type { Pool, PoolClient } from 'pg';
import type { Edge } from '../../domain/dependency-graph.js';

type Queryable = Pool | PoolClient;

export type TrackStatus = 'on_track' | 'pivot_pending' | 'blocked' | 'done';

/** Every column `track_readiness` (migrations/006_derived_track_status.sql)
 * computes for one track. `status`/`effective_done` are read-time derived
 * facts, not stored columns — see the T2.16 final design doc for the full
 * truth table this view implements. */
export interface TrackReadiness {
  own_done: boolean;
  has_pivot: boolean;
  direct_deps_ok: boolean;
  effective_done: boolean;
  status: TrackStatus;
}

export interface TrackRow {
  id: string;
  project_id: string;
  title: string;
  source_doc_ref: string | null;
  pivot_decision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export type TrackWithReadiness = TrackRow & TrackReadiness;

const TRACK_READINESS_COLUMNS = `
  tr.own_done, tr.has_pivot, tr.direct_deps_ok, tr.effective_done, tr.status
`;

export async function findTrackById(
  db: Queryable,
  projectId: string,
  trackId: string,
): Promise<TrackWithReadiness | null> {
  const result = await db.query<TrackWithReadiness>(
    `SELECT t.*, ${TRACK_READINESS_COLUMNS}
     FROM tracks t
     JOIN track_readiness tr ON tr.id = t.id
     WHERE t.id = $1 AND t.project_id = $2`,
    [trackId, projectId],
  );
  return result.rows[0] ?? null;
}

/** `effective_done` of every track in a project, keyed by id — used by
 * kt_create_track to (a) validate depends_on ids exist (via `.has`) and
 * (b) decide whether to annotate the new track with a warning (T2.16: a
 * listed dependency that isn't `effective_done` is a warning, not a hard
 * gate — see the final design doc §4). */
export async function getTrackEffectiveDoneForProject(
  db: Queryable,
  projectId: string,
): Promise<Map<string, boolean>> {
  const result = await db.query<{ id: string; effective_done: boolean }>(
    `SELECT t.id, tr.effective_done
     FROM tracks t
     JOIN track_readiness tr ON tr.id = t.id
     WHERE t.project_id = $1`,
    [projectId],
  );
  return new Map(result.rows.map((row) => [row.id, row.effective_done]));
}

export interface TrackSummary {
  id: string;
  title: string;
  status: TrackStatus;
  own_done: boolean;
  effective_done: boolean;
  /** Used by render-roadmap.ts to derive a deterministic "Generated at"
   * timestamp (TRD TEST_CASES.md ROAD-09: two calls with no DB changes
   * must return byte-identical content) — a live `new Date()` at render
   * time would fail that on the very next call. */
  updated_at: Date;
}

/** Every track's {id, title, status, own_done, effective_done, updated_at}
 * for a project, ordered by created_at ascending, then id ascending —
 * this repo's existing default track ordering (see
 * listTracksWithItemCounts's `ORDER BY t.created_at ASC`), with an `id`
 * tie-break added (adversarial-review, PR #9's review of the main-merge
 * commit): two tracks created within the same clock tick previously had
 * no defined relative order, which kt_render_roadmap relies on being
 * stable both for topoSort's tie-break input order and for ROAD-09's
 * byte-identical-repeat-call contract.
 * Used by kt_get_next_steps (looking up each pending item's track, plus
 * — T2.16 — each track's dependencies' effective_done) and
 * kt_render_roadmap (status for display, plus own_done/effective_done to
 * surface the `own_done AND NOT effective_done` drift gap). Kept separate
 * from getTrackEffectiveDoneForProject (no title/own_done) rather than
 * changing that function's return shape, since get-project-status.ts and
 * others may rely on it staying minimal. */
export async function getTrackSummariesForProject(
  db: Queryable,
  projectId: string,
): Promise<TrackSummary[]> {
  const result = await db.query<TrackSummary>(
    `SELECT t.id, t.title, tr.status, tr.own_done, tr.effective_done, t.updated_at
     FROM tracks t
     JOIN track_readiness tr ON tr.id = t.id
     WHERE t.project_id = $1
     ORDER BY t.created_at ASC, t.id ASC`,
    [projectId],
  );
  return result.rows;
}

/** All track_dependencies edges within a project, as {from, to} where
 * `from` depends on `to` — the shape dependency-graph.ts expects. */
export async function getTrackDependencyEdges(db: Queryable, projectId: string): Promise<Edge[]> {
  const result = await db.query<{ track_id: string; depends_on_track_id: string }>(
    `SELECT td.track_id, td.depends_on_track_id
     FROM track_dependencies td
     JOIN tracks t ON t.id = td.track_id
     WHERE t.project_id = $1`,
    [projectId],
  );
  return result.rows.map((row) => ({ from: row.track_id, to: row.depends_on_track_id }));
}

/** Opens a pivot: points `pivot_decision_id` at `decisionId`, guarded by
 * `pivot_decision_id IS NULL` so two concurrent opens can't both succeed
 * (T2.16 final design §6). Returns the number of rows affected (0 or 1)
 * — the caller is responsible for rolling back the decision insert this
 * must land in the same transaction with when this returns 0. */
export async function openTrackPivot(
  db: Queryable,
  trackId: string,
  decisionId: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE tracks SET pivot_decision_id = $1 WHERE id = $2 AND pivot_decision_id IS NULL`,
    [decisionId, trackId],
  );
  return result.rowCount ?? 0;
}

/** Resolves a pivot: clears `pivot_decision_id`, guarded by it currently
 * equalling `expectedDecisionId` — the compare-and-set against a
 * concurrent resolve or a new pivot opening in the meantime (T2.16 final
 * design §6). Returns the number of rows affected (0 or 1). */
export async function resolveTrackPivot(
  db: Queryable,
  trackId: string,
  expectedDecisionId: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE tracks SET pivot_decision_id = NULL WHERE id = $1 AND pivot_decision_id = $2`,
    [trackId, expectedDecisionId],
  );
  return result.rowCount ?? 0;
}

export async function insertTrack(
  db: Queryable,
  input: {
    projectId: string;
    title: string;
    sourceDocRef: string | undefined;
  },
): Promise<TrackRow> {
  const result = await db.query<TrackRow>(
    `INSERT INTO tracks (project_id, title, source_doc_ref)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.projectId, input.title, input.sourceDocRef ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertTrack: INSERT ... RETURNING produced no row');
  return row;
}

export async function insertTrackDependencies(
  db: Queryable,
  trackId: string,
  dependsOn: string[],
): Promise<void> {
  const deduped = Array.from(new Set(dependsOn));
  if (deduped.length === 0) return;
  const values: string[] = [];
  const params: string[] = [];
  deduped.forEach((depId, index) => {
    values.push(`($1, $${index + 2})`);
    params.push(depId);
  });
  await db.query(
    `INSERT INTO track_dependencies (track_id, depends_on_track_id) VALUES ${values.join(', ')}`,
    [trackId, ...params],
  );
}

export interface TrackWithCounts extends TrackRow {
  status: TrackStatus;
  own_done: boolean;
  effective_done: boolean;
  pending: number;
  in_progress: number;
  done: number;
  blocked: number;
}

export async function listTracksWithItemCounts(
  db: Queryable,
  projectId: string,
): Promise<TrackWithCounts[]> {
  const result = await db.query<TrackWithCounts>(
    `SELECT
       t.*,
       ${TRACK_READINESS_COLUMNS},
       COALESCE(SUM((i.status = 'pending')::int), 0)::int AS pending,
       COALESCE(SUM((i.status = 'in_progress')::int), 0)::int AS in_progress,
       COALESCE(SUM((i.status = 'done')::int), 0)::int AS done,
       COALESCE(SUM((i.status = 'blocked')::int), 0)::int AS blocked
     FROM tracks t
     JOIN track_readiness tr ON tr.id = t.id
     LEFT JOIN items i ON i.track_id = t.id
     WHERE t.project_id = $1
     GROUP BY t.id, tr.own_done, tr.has_pivot, tr.direct_deps_ok, tr.effective_done, tr.status
     ORDER BY t.created_at ASC`,
    [projectId],
  );
  return result.rows;
}

/** All track_dependencies ids for one track, e.g. kt_get_track's
 * `track.depends_on_track_ids` (TRD §3.5). */
export async function getDependsOnTrackIds(db: Queryable, trackId: string): Promise<string[]> {
  const result = await db.query<{ depends_on_track_id: string }>(
    `SELECT depends_on_track_id FROM track_dependencies
     WHERE track_id = $1
     ORDER BY depends_on_track_id`,
    [trackId],
  );
  return result.rows.map((row) => row.depends_on_track_id);
}

export interface TrackWithCountsAndDeps extends TrackWithCounts {
  depends_on_track_ids: string[];
}

/** kt_list_tracks (TRD §3.4): like listTracksWithItemCounts, plus each
 * track's own depends_on_track_ids and an optional status filter — now a
 * filter on the derived `track_readiness.status`, since track status is
 * no longer a stored column (T2.16). Kept as its own query rather than
 * extending listTracksWithItemCounts so kt_get_project_status's existing
 * shape/callers are untouched. */
export async function listTracksForListing(
  db: Queryable,
  projectId: string,
  status: TrackStatus | undefined,
): Promise<TrackWithCountsAndDeps[]> {
  const result = await db.query<TrackWithCountsAndDeps>(
    `SELECT
       t.*,
       ${TRACK_READINESS_COLUMNS},
       COALESCE(SUM((i.status = 'pending')::int), 0)::int AS pending,
       COALESCE(SUM((i.status = 'in_progress')::int), 0)::int AS in_progress,
       COALESCE(SUM((i.status = 'done')::int), 0)::int AS done,
       COALESCE(SUM((i.status = 'blocked')::int), 0)::int AS blocked,
       COALESCE(
         (SELECT array_agg(td.depends_on_track_id ORDER BY td.depends_on_track_id)
          FROM track_dependencies td
          WHERE td.track_id = t.id),
         ARRAY[]::uuid[]
       ) AS depends_on_track_ids
     FROM tracks t
     JOIN track_readiness tr ON tr.id = t.id
     LEFT JOIN items i ON i.track_id = t.id
     WHERE t.project_id = $1 AND ($2::text IS NULL OR tr.status = $2)
     GROUP BY t.id, tr.own_done, tr.has_pivot, tr.direct_deps_ok, tr.effective_done, tr.status
     ORDER BY t.created_at ASC`,
    [projectId, status ?? null],
  );
  return result.rows;
}
