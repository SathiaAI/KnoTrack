import type { Pool, PoolClient } from 'pg';

/** Runs `fn` inside a BEGIN/COMMIT transaction on a dedicated client,
 * rolling back on any thrown error. Used by every write-path tool that
 * touches more than one table (TRD calls out several "in the same
 * transaction as" requirements — §3.6, §3.7, §3.9, §3.10). */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* rollback failure is secondary to the original error */
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a single REPEATABLE READ, read-only transaction on one
 * dedicated client, so multiple reads see one consistent snapshot instead
 * of each hitting its own pool connection/snapshot and potentially
 * observing different points in time if a write commits in between.
 *
 * adversarial-review P2: kt_get_project_status's three roll-up queries
 * used to run on `pool` directly (Promise.all over separate connections),
 * so a concurrent commit landing mid-flight could produce a response
 * mixing pre- and post-commit state that never represented any actual DB
 * state at any instant. Used for read-only roll-ups only — nothing here
 * is ever meant to write, hence READ ONLY.
 */
export async function withReadSnapshot<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        /* rollback failure is secondary to the original error */
      });
      throw error;
    }
  } finally {
    client.release();
  }
}
