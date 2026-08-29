// Process entrypoint: load config, run pre-flight checks, start Fastify.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent } from './config/load-dotenv.js';
import { loadConfig } from './config/env.js';
import { initContext, getDb } from './mcp/context.js';
import { buildFastify } from './server/fastify.js';
import { closePool } from './db/pool.js';
import { getPendingMigrationFiles } from './db/migration-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // docs/ROADMAP.md T3.8: refuse to come up "healthy" against a stale or
  // missing schema, regardless of whether the platform-level migration step
  // ran, was skipped, or fails in some new way — this must be a structural
  // guard, not a cosmetic warning. Resolved the same way
  // scripts/migrate.ts resolves MIGRATIONS_DIR: this compiled file lives at
  // dist/src/index.js, one directory below dist/, so `..` + 'migrations'
  // lands on dist/migrations — the same directory the Docker/Railpack build
  // copies migrations/ into.
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  const pendingMigrations = await getPendingMigrationFiles(pool, migrationsDir);
  if (pendingMigrations.length > 0) {
    app.log.fatal(
      { pendingMigrations },
      `refusing to start: ${pendingMigrations.length} pending migration(s) not applied: ` +
        `${pendingMigrations.join(', ')} — run the migration step before starting the server`,
    );
    await app.close();
    await closePool();
    process.exit(1);
  }

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
