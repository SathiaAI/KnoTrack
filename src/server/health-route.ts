// GET /health and GET /info — docs/TRD.md §8. Both plain, unauthenticated
// Fastify routes, not MCP tools.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config/env.js';
import { createPool } from '../db/pool.js';

const SERVER_VERSION = '0.1.0';
const MCP_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_ADAPTERS = ['github', 'linear'];

async function pingDb(pool: Pool, timeoutMs: number): Promise<boolean> {
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs),
  );
  try {
    const result = await Promise.race([pool.query('SELECT 1'), timeout]);
    return result !== 'timeout';
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
  });
  app.addHook('onClose', async () => {
    await healthPool.end();
  });

  app.get('/health', async (_request, reply) => {
    const dbOk = await pingDb(healthPool, 1000);
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
    return reply.code(200).send({
      server_version: SERVER_VERSION,
      mcp_protocol_version: MCP_PROTOCOL_VERSION,
      node_version: process.version,
      supported_adapters: SUPPORTED_ADAPTERS,
      instance_started_at: instanceStartedAt.toISOString(),
    });
  });
}
