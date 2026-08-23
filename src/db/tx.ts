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
