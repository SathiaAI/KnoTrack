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
import {
  decodeAndValidateSslCa,
  resolveSslMode,
  stripSslQueryParams,
} from '../src/db/ssl-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

// Allows (and preserves) a run of blank lines and `-- ...` comment lines —
// e.g. a migration file's descriptive header — before the leading `BEGIN;`.
// Group 1 captures that leading run so it survives the strip below; only
// the `BEGIN;` token itself (plus trailing whitespace) is removed.
const LEADING_BEGIN = /^((?:\s|--[^\r\n]*(?:\r?\n|$))*)BEGIN;\s*/i;
const TRAILING_COMMIT = /\s*COMMIT;\s*$/i;

// Session-level Postgres advisory lock key for the migration pass as a
// whole (CodeRabbit re-review: two concurrent `npm run migrate` invocations
// could both read schema_migrations, both pick the same pending file, and
// one fails hitting objects the other already created). A single fixed
// bigint identifies "the KnoTrack migration runner" across every process
// that calls applyMigrations against the same database, regardless of
// migrations directory or file contents — it's derived once (FNV-1a 64
// hash of the literal string "knotrack_migrations", folded into the signed
// 64-bit range pg_advisory_lock's `bigint` parameter requires) and then
// hardcoded so no hashing happens at runtime.
export const MIGRATION_ADVISORY_LOCK_KEY = -2365753259700777648n;

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
 *
 * CodeRabbit re-review regression: the original LEADING_BEGIN pattern
 * only tolerated whitespace before `BEGIN;`, so any migration starting
 * with a `-- ...` comment header (e.g.
 * migrations/003_drift_flags_open_unique.sql) failed this function's own
 * "must start with BEGIN;" check and threw, even though the file is a
 * perfectly valid BEGIN/COMMIT-wrapped migration. LEADING_BEGIN now allows
 * and preserves that header instead of requiring it to be absent.
 */
function stripTransactionWrapper(sql: string, file: string): string {
  if (!LEADING_BEGIN.test(sql) || !TRAILING_COMMIT.test(sql)) {
    throw new Error(
      `migration ${file} must start with "BEGIN;" (optionally preceded by blank lines and ` +
        '"-- ..." comment lines) and end with "COMMIT;" — the runner strips those to wrap the ' +
        'DDL and its schema_migrations row in one transaction it controls',
    );
  }
  return sql.replace(LEADING_BEGIN, '$1').replace(TRAILING_COMMIT, '');
}

/**
 * Applies every not-yet-applied `<name>.sql` file in `migrationsDir` (in
 * filename order) to `client`, atomically per file (see
 * stripTransactionWrapper's doc comment). Extracted from `main()` so it's
 * callable directly against a test database and a scratch migrations
 * directory, independent of process.env/process.exit.
 */
export async function applyMigrations(client: ClientBase, migrationsDir: string): Promise<number> {
  // Session-level advisory lock spanning the entire pass (acquired before
  // even the pending-migrations read, released only once every migration in
  // this run has been applied or the pass has failed) so two concurrent
  // runner invocations against the same database serialize instead of
  // racing to apply the same file. This is a session lock, not a
  // transaction-scoped one, so it's acquired/released explicitly rather
  // than via BEGIN/COMMIT.
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();

    const appliedResult = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
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
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {
      /* unlock failure is secondary to whatever the try block already threw/returned;
         the lock is session-scoped, so it's also released automatically when this
         client's connection eventually closes. */
    });
  }
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  // Mirrors loadConfig()'s own default (src/config/env.ts) via the shared
  // resolveSslMode helper: DATABASE_SSL_MODE unset means "require in
  // production, disable otherwise" — the same as the app itself, not
  // unconditionally 'disable' regardless of NODE_ENV. PR #11 review
  // finding (Codex): this used to hardcode 'disable' here, so a
  // production deploy that never set DATABASE_SSL_MODE explicitly would
  // silently skip TLS during the migration step even though the app's
  // own pool would enforce it.
  const sslMode = resolveSslMode(process.env.NODE_ENV, process.env.DATABASE_SSL_MODE);
  // Same fix as src/db/pool.ts (adversarial-review security-2/data_privacy-1):
  // verify the server's TLS certificate by default; only an explicit
  // KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED=false opts out, for a broken/
  // self-signed local dev certificate.
  const sslRejectUnauthorized = process.env.KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED !== 'false';
  // Same CA-pinning support as src/db/pool.ts (docs/TRD.md §7,
  // KNOTRACK_DB_SSL_CA_BASE64) — this script deliberately doesn't go
  // through loadConfig()/createPool() (a migration run shouldn't have to
  // supply KNOTRACK_API_TOKENS/KNOTRACK_ENCRYPTION_KEY just to connect),
  // so it calls the same shared validator (src/db/ssl-config.ts) directly
  // rather than going through the Zod schema. decodeAndValidateSslCa
  // throws on malformed input — PR #11 review finding (CodeRabbit): the
  // old inline `Buffer.from(...).toString('utf8')` silently decoded a
  // malformed value (e.g. `%%%%`) into an empty string, which fell
  // through to the `rejectUnauthorized` branch below instead of failing
  // loudly.
  const sslCaBase64 = process.env.KNOTRACK_DB_SSL_CA_BASE64;
  const sslCa = sslCaBase64 ? decodeAndValidateSslCa(sslCaBase64) : undefined;
  const client = new Client({
    // Same query-param-stripping protection as src/db/pool.ts — a
    // DATABASE_URL containing e.g. ?sslmode=no-verify would otherwise
    // silently override the ssl option built below.
    connectionString: stripSslQueryParams(databaseUrl),
    ssl:
      sslMode === 'require'
        ? sslCa
          ? { ca: sslCa, rejectUnauthorized: true }
          : { rejectUnauthorized: sslRejectUnauthorized }
        : undefined,
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
