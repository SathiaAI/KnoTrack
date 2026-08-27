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

/** kt_update_item_status (TRD §3.11): find one item scoped to its
 * project, distinguishing "doesn't exist at all" from "exists but a
 * different project" (404 either way, per TRD) the same way
 * findTrackById (tracks.ts) scopes tracks by project. Items don't carry
 * `project_id` directly, so this joins through the owning track.
 *
 * Locks the item row (`FOR UPDATE`) — adversarial-review P2: the
 * `done -> done` no-op exemption reads this row's *current* status to
 * decide whether to run the unmet-dependency check at all. Without a
 * lock here, two concurrent kt_update_item_status calls on the same item
 * can both read the same pre-transition status: e.g. call A reads
 * `done`, call B concurrently transitions the item to `pending` (leaving
 * an unmet dependency reopened) and commits, then call A — having
 * already decided from its earlier read that this is a `done -> done`
 * no-op — writes `done` again without ever running the check, silently
 * performing what is actually a `pending -> done` transition that should
 * have been rejected. Locking the row here forces a concurrent status
 * change to wait until this transaction commits or rolls back, so the
 * two calls serialize instead of racing. Must be called inside the same
 * transaction as the eventual status UPDATE — a bare Pool would release
 * the lock immediately, which is why this takes a PoolClient, not the
 * shared Queryable type. */
export async function findItemInProject(
  db: PoolClient,
  projectId: string,
  itemId: string,
): Promise<ItemRow | null> {
  const result = await db.query<ItemRow>(
    `SELECT i.*
     FROM items i
     JOIN tracks t ON t.id = i.track_id
     WHERE i.id = $1 AND t.project_id = $2
     FOR UPDATE OF i`,
    [itemId, projectId],
  );
  return result.rows[0] ?? null;
}

/**
 * The ids of `itemId`'s dependencies (via item_dependencies) whose status
 * is not currently 'done' — the unmet set kt_update_item_status's
 * transition-to-done check needs (TRD §3.11).
 *
 * Locks each dependency's item row (`FOR UPDATE OF dep`) while reading.
 * This is a read-then-write, same shape as the race
 * lockTrackForSequenceAssignment (above) guards against for
 * sequence_position: the caller is about to decide, based on this read,
 * whether to write `status = 'done'` on `itemId`. Without the lock, a
 * concurrent kt_update_item_status call moving one of these dependencies
 * *off* 'done' could commit in the gap between this read and that write,
 * letting `itemId` be marked done against a dependency that is no longer
 * done by the time either transaction settles. Locking the dependency
 * rows here forces that concurrent call to wait until this transaction
 * commits or rolls back, so the two calls serialize instead of racing.
 * Must be called inside the same transaction as the eventual status
 * UPDATE — a bare Pool would release the lock immediately, which is why
 * this takes a PoolClient, not the shared Queryable type.
 *
 * `ORDER BY dep.id` before locking (adversarial-review P2): two items
 * with overlapping but oppositely-ordered dependency sets (e.g. one
 * depends on [X, Y], another on [Y, X]) being marked done concurrently
 * would otherwise lock their shared dependency rows in whatever order
 * Postgres happens to return them — different orders let one transaction
 * hold X while waiting for Y and the other hold Y while waiting for X,
 * which Postgres resolves by aborting one with a deadlock error (surfaced
 * by `runTool` as an opaque 500 instead of the tool's own documented
 * error shapes). Every caller locking these rows in the same
 * (id-ascending) order removes the possibility of a lock cycle entirely.
 */
export async function getUnmetDependencyIds(db: PoolClient, itemId: string): Promise<string[]> {
  const result = await db.query<{ id: string; status: ItemStatus }>(
    `SELECT dep.id, dep.status
     FROM item_dependencies idep
     JOIN items dep ON dep.id = idep.depends_on_item_id
     WHERE idep.item_id = $1
     ORDER BY dep.id
     FOR UPDATE OF dep`,
    [itemId],
  );
  return result.rows.filter((row) => row.status !== 'done').map((row) => row.id);
}

/** kt_update_item_status (TRD §3.11). No `updated_at` here —
 * `trg_items_set_updated_at` (migrations/001_init.sql) already bumps it
 * on every UPDATE. */
export async function updateItemStatus(
  db: Queryable,
  itemId: string,
  status: ItemStatus,
): Promise<void> {
  await db.query(`UPDATE items SET status = $1 WHERE id = $2`, [status, itemId]);
}
