// Process entrypoint: load config, run pre-flight checks, start Fastify.
import { loadDotEnvIfPresent } from './config/load-dotenv.js';
import { loadConfig } from './config/env.js';
import { initContext, getDb } from './mcp/context.js';
import { buildFastify } from './server/fastify.js';
import { closePool } from './db/pool.js';

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();
  initContext(config);
  const pool = getDb();

  // Pre-flight: fail fast on an unreachable DB rather than starting and
  // serving 500s until the operator notices.
  await pool.query('SELECT 1');

  const instanceStartedAt = new Date();
  const app = buildFastify(pool, config, instanceStartedAt);

  await app.listen({ port: config.port, host: config.host });

  // A second signal (or a signal arriving while the first is still
  // closing) must not start a concurrent shutdown, and a rejection from
  // either close call must not leave this an unhandled rejection with the
  // process hanging until something sends SIGKILL.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closePool();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error, signal }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('fatal startup error:', error);
  process.exit(1);
});
