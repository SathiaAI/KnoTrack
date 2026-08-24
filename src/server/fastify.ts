// Builds the Fastify instance and registers routes/hooks.
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config/env.js';
import { registerHealthRoutes } from './health-route.js';
import { registerMcpRoute } from './mcp-route.js';

export function buildFastify(pool: Pool, config: Config, instanceStartedAt: Date): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  registerHealthRoutes(app, config, instanceStartedAt);
  registerMcpRoute(app, pool, config);

  return app;
}
