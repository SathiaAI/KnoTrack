import type { Pool, PoolClient } from 'pg';
import type { Edge } from '../../domain/dependency-graph.js';

type Queryable = Pool | PoolClient;

export type TrackStatus = 'on_track' | 'pivot_pending' | 'blocked' | 'done';

export interface TrackRow {
  id: string;
  project_id: string;
  title: string;
  status: TrackStatus;
  source_doc_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function findTrackById(
  db: Queryable,
  projectId: string,
  trackId: string,
): Promise<TrackRow | null> {
  const result = await db.query<TrackRow>(
    `SELECT * FROM tracks WHERE id = $1 AND project_id = $2`,
    [trackId, projectId],
  );
  return result.rows[0] ?? null;
}

/** Status of every track in a project, keyed by id — used to validate
 * depends_on ids exist and to check whether they're all `done`. */
export async function getTrackStatusesForProject(
  db: Queryable,
  projectId: string,
): Promise<Map<string, TrackStatus>> {
  const result = await db.query<{ id: string; status: TrackStatus }>(
    `SELECT id, status FROM tracks WHERE project_id = $1`,
    [projectId],
  );
  return new Map(result.rows.map((row) => [row.id, row.status]));
}

export interface TrackSummary {
  id: string;
  title: string;
  status: TrackStatus;
  /** Used by render-roadmap.ts to derive a deterministic "Generated at"
   * timestamp (TRD TEST_CASES.md ROAD-09: two calls with no DB changes
   * must return byte-identical content) — a live `new Date()` at render
   * time would fail that on the very next call. */
  updated_at: Date;
}

/** Every track's {id, title, status} for a project, ordered by
 * created_at ascending — this repo's existing default track ordering
 * (see listTracksWithItemCounts's `ORDER BY t.created_at ASC`). Used by
 * kt_get_next_steps (looking up each pending item's track) and
 * kt_render_roadmap (topoSort's tie-break input order). Kept separate
 * from getTrackStatusesForProject (status only, no title) rather than
 * changing that function's return shape, since get-project-status.ts and
 * others may rely on it staying status-only. */
export async function getTrackSummariesForProject(
  db: Queryable,
  projectId: string,
): Promise<TrackSummary[]> {
  const result = await db.query<TrackSummary>(
    `SELECT id, title, status, updated_at FROM tracks WHERE project_id = $1 ORDER BY created_at ASC`,
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

export async function insertTrack(
  db: Queryable,
  input: {
    projectId: string;
    title: string;
    status: TrackStatus;
    sourceDocRef: string | undefined;
  },
): Promise<TrackRow> {
  const result = await db.query<TrackRow>(
    `INSERT INTO tracks (project_id, title, status, source_doc_ref)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.projectId, input.title, input.status, input.sourceDocRef ?? null],
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
       COALESCE(SUM((i.status = 'pending')::int), 0)::int AS pending,
       COALESCE(SUM((i.status = 'in_progress')::int), 0)::int AS in_progress,
       COALESCE(SUM((i.status = 'done')::int), 0)::int AS done,
       COALESCE(SUM((i.status = 'blocked')::int), 0)::int AS blocked
     FROM tracks t
     LEFT JOIN items i ON i.track_id = t.id
     WHERE t.project_id = $1
     GROUP BY t.id
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
 * track's own depends_on_track_ids and an optional status filter. Kept
 * as its own query rather than extending listTracksWithItemCounts so
 * kt_get_project_status's existing shape/callers are untouched. */
export async function listTracksForListing(
  db: Queryable,
  projectId: string,
  status: TrackStatus | undefined,
): Promise<TrackWithCountsAndDeps[]> {
  const result = await db.query<TrackWithCountsAndDeps>(
    `SELECT
       t.*,
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
     LEFT JOIN items i ON i.track_id = t.id
     WHERE t.project_id = $1 AND ($2::text IS NULL OR t.status = $2)
     GROUP BY t.id
     ORDER BY t.created_at ASC`,
    [projectId, status ?? null],
  );
  return result.rows;
}
