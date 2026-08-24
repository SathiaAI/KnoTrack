import { describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { HEALTH_CHECK_STATEMENT_TIMEOUT_MS } from '../../src/server/health-route.js';
import { getTestConfig } from './helpers.js';

// adversarial-review P2: registerHealthRoutes's pingDb used to race
// pool.query('SELECT 1') against a client-side setTimeout — that only
// stopped the /health *request* from waiting, it never canceled the query
// itself. A slow/unreachable DB left the query running to completion (or
// to the much larger default statement_timeout) on one of the health
// pool's 2 connections regardless, so repeated timed-out checks could pile
// up work behind that small pool. The fix sets `statement_timeout` on the
// health pool itself, so Postgres — not just the JS side — cancels a slow
// query at the bound and frees the connection back to the pool.
//
// This test exercises the exact mechanism the fix relies on (a pool built
// with the same override shape health-route.ts uses, including its
// exported timeout constant) against a genuinely slow query, rather than
// the /health route itself — there's no way to make the route's hardcoded
// `SELECT 1` slow from the outside.
describe('health pool statement_timeout (adversarial-review P2)', () => {
  const config = getTestConfig();

  it('cancels a slow query at the configured statement_timeout and leaves the pool usable afterward', async () => {
    const pool = createPool(config, {
      max: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      statement_timeout: HEALTH_CHECK_STATEMENT_TIMEOUT_MS,
    });
    try {
      const start = Date.now();
      await expect(pool.query('SELECT pg_sleep(3)')).rejects.toThrow(/statement timeout/i);
      const elapsedMs = Date.now() - start;
      // Cancelled at ~HEALTH_CHECK_STATEMENT_TIMEOUT_MS (1s), nowhere near
      // the full 3s the query itself asked to sleep for. Before the fix
      // (no statement_timeout override — inherits the much larger default),
      // this same query would have run to completion instead of rejecting.
      expect(elapsedMs).toBeLessThan(2500);

      // The connection the cancelled query held must come back to the pool
      // usable, not leaked/stuck — a subsequent query on this same
      // 2-connection pool must still succeed promptly.
      const result = await pool.query<{ one: number }>('SELECT 1 AS one');
      expect(result.rows[0]).toEqual({ one: 1 });
    } finally {
      await pool.end();
    }
  });
});
