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
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function main(): Promise<void> {
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
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = readdirSync(MIGRATIONS_DIR)
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
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`applying: ${file}`);
      // The migration file itself already wraps its DDL in BEGIN/COMMIT;
      // run it as a single simple-query call so multi-statement SQL
      // executes as node-postgres's simple query protocol supports.
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      appliedCount += 1;
    }

    if (appliedCount === 0) {
      console.log('no pending migrations — schema already up to date');
    } else {
      console.log(`applied ${appliedCount} migration(s)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error);
  process.exit(1);
});
