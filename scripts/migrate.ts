#!/usr/bin/env tsx
// Thin migration runner.
//
// TRD §1 mandates node-pg-migrate as the migrations tool. This repo's
// only migration (migrations/001_init.sql / 001_init.down.sql) already
// exists as a hand-written raw-SQL up/down pair rather than a file
// node-pg-migrate's own `migrate create` produced — node-pg-migrate's SQL
// mode expects specific timestamp-prefixed naming/pairing conventions
// from that command, and retrofitting an existing pair onto it risked
// fighting the tool's own bookkeeping for zero behavioral benefit on a
// single-migration repo. Resolution: a small, idempotent custom runner
// that tracks applied migrations in a `schema_migrations` table and
// applies each `<name>.sql` file (in filename order) transactionally,
// exactly the "minimal custom runner if that's simpler" option this
// build was explicitly permitted to take.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type ClientBase } from 'pg';
import { loadDotEnvIfPresent } from '../src/config/load-dotenv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

const LEADING_BEGIN = /^\s*BEGIN;\s*/i;
const TRAILING_COMMIT = /\s*COMMIT;\s*$/i;

/**
 * Strips a migration file's own leading `BEGIN;` / trailing `COMMIT;` so
 * the runner can wrap the DDL and its `schema_migrations` bookkeeping row
 * in one transaction it controls itself (see the call site below).
 *
 * adversarial-review P2: each migration file commits its own DDL (via its
 * embedded BEGIN/COMMIT) before this runner's separate
 * `INSERT INTO schema_migrations` statement — two separate transactions.
 * A process death between them leaves the schema changed but no record of
 * it, so the same file re-runs next time and fails on objects that
 * already exist.
 */
function stripTransactionWrapper(sql: string, file: string): string {
  if (!LEADING_BEGIN.test(sql) || !TRAILING_COMMIT.test(sql)) {
    throw new Error(
      `migration ${file} must start with "BEGIN;" and end with "COMMIT;" — the runner strips ` +
        'those to wrap the DDL and its schema_migrations row in one transaction it controls',
    );
  }
  return sql.replace(LEADING_BEGIN, '').replace(TRAILING_COMMIT, '');
}

/**
 * Applies every not-yet-applied `<name>.sql` file in `migrationsDir` (in
 * filename order) to `client`, atomically per file (see
 * stripTransactionWrapper's doc comment). Extracted from `main()` so it's
 * callable directly against a test database and a scratch migrations
 * directory, independent of process.env/process.exit.
 */
export async function applyMigrations(client: ClientBase, migrationsDir: string): Promise<number> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  const appliedResult = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map((r) => r.name));

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip (already applied): ${file}`);
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    const ddl = stripTransactionWrapper(sql, file);
    console.log(`applying: ${file}`);
    // Runner-controlled transaction wrapping both the DDL and the
    // schema_migrations row, so a process death mid-migration can never
    // leave one committed without the other (see stripTransactionWrapper's
    // doc comment). The file's own BEGIN/COMMIT (stripped above) still
    // makes it independently runnable via psql.
    await client.query('BEGIN');
    try {
      // Multi-statement DDL runs as a single simple-query call, which
      // node-postgres's simple query protocol supports.
      await client.query(ddl);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        /* rollback failure is secondary to the original error */
      });
      throw error;
    }
    appliedCount += 1;
  }

  return appliedCount;
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const sslMode = process.env.DATABASE_SSL_MODE ?? 'disable';
  // Same fix as src/db/pool.ts (adversarial-review security-2/data_privacy-1):
  // verify the server's TLS certificate by default; only an explicit
  // KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED=false opts out, for a broken/
  // self-signed local dev certificate.
  const sslRejectUnauthorized = process.env.KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED !== 'false';
  const client = new Client({
    connectionString: databaseUrl,
    ssl: sslMode === 'require' ? { rejectUnauthorized: sslRejectUnauthorized } : undefined,
  });
  await client.connect();

  try {
    const appliedCount = await applyMigrations(client, MIGRATIONS_DIR);
    if (appliedCount === 0) {
      console.log('no pending migrations — schema already up to date');
    } else {
      console.log(`applied ${appliedCount} migration(s)`);
    }
  } finally {
    await client.end();
  }
}

// Only auto-run when this file is the process entrypoint (`tsx
// scripts/migrate.ts` / `node dist/scripts/migrate.js`), not when
// `applyMigrations` is imported elsewhere (e.g. by tests) — importing an
// ES module always executes its top-level code, so without this guard
// every import of this file would also run a real migration against
// `process.env.DATABASE_URL`, `process.exit()` included.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error('migration failed:', error);
    process.exit(1);
  });
}
