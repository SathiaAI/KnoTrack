import type { Pool, PoolClient } from 'pg';
import type { Edge } from '../../domain/dependency-graph.js';

type Queryable = Pool | PoolClient;

export type ItemStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface ItemRow {
  id: string;
  track_id: string;
  title: string;
  sequence_position: number;
  status: ItemStatus;
  created_at: Date;
  updated_at: Date;
}

export async function getMaxSequencePosition(db: Queryable, trackId: string): Promise<number> {
  const result = await db.query<{ max: number | null }>(
    `SELECT MAX(sequence_position) AS max FROM items WHERE track_id = $1`,
    [trackId],
  );
  return result.rows[0]?.max ?? 0;
}

/** Locks the track row for the remainder of the caller's transaction.
 * adversarial-review correctness-1: getMaxSequencePosition() followed by
 * insertItem() is a read-then-write with no unique constraint backing it —
 * two concurrent kt_create_item calls on the same track could both read
 * the same MAX and insert the same sequence_position. Callers must take
 * this lock (inside the same transaction, before computing the max)
 * whenever they are about to auto-assign a sequence_position, so
 * concurrent auto-assigns on one track serialize instead of racing. Must
 * be called with a PoolClient already inside BEGIN/COMMIT — a bare Pool
 * would release the lock immediately. */
export async function lockTrackForSequenceAssignment(
  db: PoolClient,
  trackId: string,
): Promise<void> {
  await db.query(`SELECT id FROM tracks WHERE id = $1 FOR UPDATE`, [trackId]);
}

/** Fetch a set of items by id regardless of track, keyed by id — used to
 * distinguish "id doesn't exist as an item at all" (404) from "exists but
 * wrong track" (422) per TRD §3.7 / §3.9. */
export async function getItemsByIds(db: Queryable, ids: string[]): Promise<Map<string, ItemRow>> {
  if (ids.length === 0) return new Map();
  const result = await db.query<ItemRow>(`SELECT * FROM items WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(result.rows.map((row) => [row.id, row]));
}

export async function getItemDependencyEdgesForTrack(
  db: Queryable,
  trackId: string,
): Promise<Edge[]> {
  const result = await db.query<{ item_id: string; depends_on_item_id: string }>(
    `SELECT id.item_id, id.depends_on_item_id
     FROM item_dependencies id
     JOIN items i ON i.id = id.item_id
     WHERE i.track_id = $1`,
    [trackId],
  );
  return result.rows.map((row) => ({ from: row.item_id, to: row.depends_on_item_id }));
}

/**
 * Shifts every item at or after `fromPosition` one position later, making
 * room to insert a new item at exactly `fromPosition`. Must be called
 * inside the same transaction as the insert, after
 * `lockTrackForSequenceAssignment` — same race this project already backs
 * the auto-assign path with, since this is also a read-then-write
 * (deciding which rows to shift) with no unique constraint on
 * sequence_position to catch a concurrent collision otherwise.
 */
export async function shiftSequencePositionsFrom(
  db: PoolClient,
  trackId: string,
  fromPosition: number,
): Promise<void> {
  await db.query(
    `UPDATE items SET sequence_position = sequence_position + 1
     WHERE track_id = $1 AND sequence_position >= $2`,
    [trackId, fromPosition],
  );
}

export async function insertItem(
  db: Queryable,
  input: { trackId: string; title: string; sequencePosition: number },
): Promise<ItemRow> {
  const result = await db.query<ItemRow>(
    `INSERT INTO items (track_id, title, sequence_position)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.trackId, input.title, input.sequencePosition],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertItem: INSERT ... RETURNING produced no row');
  return row;
}

export async function insertItemDependencies(
  db: Queryable,
  itemId: string,
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
    `INSERT INTO item_dependencies (item_id, depends_on_item_id) VALUES ${values.join(', ')}`,
    [itemId, ...params],
  );
}

export async function listItemsByTrack(db: Queryable, trackId: string): Promise<ItemRow[]> {
  const result = await db.query<ItemRow>(
    `SELECT * FROM items WHERE track_id = $1 ORDER BY sequence_position ASC`,
    [trackId],
  );
  return result.rows;
}

/** Items for one track, capped and ordered by sequence_position — used by
 * kt_render_roadmap (TRD §6.3) so a track holding more than
 * KNOTRACK_ROADMAP_ITEM_PER_TRACK_CAP items doesn't blow past the render
 * budget. Callers pass `limit = cap + 1` to detect "more exist beyond the
 * cap" from the result's length without a separate COUNT query. Kept
 * separate from the uncapped listItemsByTrack, which kt_get_track relies
 * on returning every item unconditionally. */
export async function listItemsByTrackCapped(
  db: Queryable,
  trackId: string,
  limit: number,
): Promise<ItemRow[]> {
  const result = await db.query<ItemRow>(
    `SELECT * FROM items WHERE track_id = $1 ORDER BY sequence_position ASC LIMIT $2`,
    [trackId, limit],
  );
  return result.rows;
}

export interface PendingItemWithDeps {
  id: string;
  track_id: string;
  title: string;
  sequence_position: number;
  created_at: Date;
  depends_on_item_ids: string[];
}

/** Every pending item across a project's tracks, with each item's own
 * depends_on_item_ids inlined via a correlated array_agg subquery — same
 * pattern as tracks.ts's listTracksForListing. Feeds kt_get_next_steps's
 * pure ranking function (src/domain/next-steps.ts, TRD §3.8 steps 1-2). */
export async function listPendingItemsForProject(
  db: Queryable,
  projectId: string,
): Promise<PendingItemWithDeps[]> {
  const result = await db.query<PendingItemWithDeps>(
    `SELECT
       i.id, i.track_id, i.title, i.sequence_position, i.created_at,
       COALESCE(
         (SELECT array_agg(dep.depends_on_item_id ORDER BY dep.depends_on_item_id)
          FROM item_dependencies dep WHERE dep.item_id = i.id),
         ARRAY[]::uuid[]
       ) AS depends_on_item_ids
     FROM items i
     JOIN tracks t ON t.id = i.track_id
     WHERE t.project_id = $1 AND i.status = 'pending'`,
    [projectId],
  );
  return result.rows;
}

/** Status of every item in a project (regardless of that item's own
 * status), keyed by id — used to check whether a pending item's
 * dependencies are all `done` (kt_get_next_steps, TRD §3.8 step 2)
 * without a per-item second query. Fetching the whole project's items
 * once and passing the resulting map into the pure domain function is
 * simplest here; unlike drift-scan/roadmap, the TRD sets no cap for
 * kt_get_next_steps. */
export async function getItemStatusesForProject(
  db: Queryable,
  projectId: string,
): Promise<Map<string, ItemStatus>> {
  const result = await db.query<{ id: string; status: ItemStatus }>(
    `SELECT i.id, i.status
     FROM items i
     JOIN tracks t ON t.id = i.track_id
     WHERE t.project_id = $1`,
    [projectId],
  );
  return new Map(result.rows.map((row) => [row.id, row.status]));
}
