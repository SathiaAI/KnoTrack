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
