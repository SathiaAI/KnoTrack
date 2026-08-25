// GET /health and GET /info — docs/TRD.md §8. Both plain, unauthenticated
// Fastify routes, not MCP tools.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config/env.js';
import { createPool } from '../db/pool.js';

const SERVER_VERSION = '0.1.0';
const MCP_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_ADAPTERS = ['github', 'linear'];

// How long a single /health ping is allowed to run before Postgres itself
// cancels it. adversarial-review: this used to be a client-side
// `Promise.race` against a `setTimeout` — that only stopped *this request*
// from waiting on `pool.query('SELECT 1')`, it never actually canceled the
// query. A slow/unreachable DB left it running to completion (or to the
// pool's own, much larger `statement_timeout`) on one of the health pool's
// 2 connections regardless, so repeated timed-out requests could tie up
// both connections and pile up pending acquisitions behind them. Setting
// `statement_timeout` on the health pool itself makes Postgres cancel the
// query server-side at this bound, which frees the connection back to the
// pool for the next check instead of just abandoning it client-side.
export const HEALTH_CHECK_STATEMENT_TIMEOUT_MS = 1000;

async function pingDb(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export function registerHealthRoutes(
  app: FastifyInstance,
  config: Config,
  instanceStartedAt: Date,
): void {
  // adversarial-review security-1: /health is unauthenticated by design
  // (docs/TRD.md §8) but was pinging the same pool the authenticated MCP
  // tool traffic depends on. A flood of unauthenticated /health requests
  // (or a slow DB making pingDb's queries queue past the 1s race timeout)
  // could hold connections/queue slots on that shared pool, starving real
  // MCP calls. A small, dedicated pool isolates that blast radius: /health
  // can only ever contend with itself, never with tool traffic. Closed via
  // Fastify's onClose hook so it doesn't outlive the server.
  const healthPool = createPool(config, {
    max: 2,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: HEALTH_CHECK_STATEMENT_TIMEOUT_MS,
  });
  app.addHook('onClose', async () => {
    await healthPool.end();
  });

  app.get('/health', async (_request, reply) => {
    const dbOk = await pingDb(healthPool);
    const uptimeSeconds = Math.floor((Date.now() - instanceStartedAt.getTime()) / 1000);
    if (dbOk) {
      return reply.code(200).send({
        status: 'ok',
        version: SERVER_VERSION,
        mcp_protocol_version: MCP_PROTOCOL_VERSION,
        uptime_seconds: uptimeSeconds,
        db: 'ok',
      });
    }
    return reply.code(503).send({
      status: 'error',
      version: SERVER_VERSION,
      uptime_seconds: uptimeSeconds,
      db: 'error',
      error: 'db_unreachable',
    });
  });

  app.get('/info', async (_request, reply) => {
    // adversarial-review security-5 (docs/ROADMAP.md T9.x): /info is
    // unauthenticated by design (docs/TRD.md §8), so anything it discloses
    // is available to an unauthenticated caller fingerprinting the server.
    // The Node.js runtime version was pure recon value (helps target
    // known Node CVEs) with no legitimate client use — removed rather than
    // gated, since no documented client behavior depends on it.
    return reply.code(200).send({
      server_version: SERVER_VERSION,
      mcp_protocol_version: MCP_PROTOCOL_VERSION,
      supported_adapters: SUPPORTED_ADAPTERS,
      instance_started_at: instanceStartedAt.toISOString(),
    });
  });
}
