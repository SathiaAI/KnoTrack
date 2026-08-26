import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATION_ADVISORY_LOCK_KEY } from '../../scripts/migrate.js';
import { closeTestPool, getTestPool } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = getTestPool();

function makeScratchMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'knotrack-migrate-test-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  // Cleanup shared with every test below — scratch tables/rows this file's
  // migrations may have created on the real local scratch DB, plus the
  // schema_migrations bookkeeping rows so re-running this suite doesn't
  // hit "already applied" on names it reuses.
  await pool.query('DROP TABLE IF EXISTS knotrack_migrate_test_ok');
  await pool.query('DROP TABLE IF EXISTS knotrack_migrate_test_atomic');
  await pool.query('DROP TRIGGER IF EXISTS trg_knotrack_migrate_test_fail ON schema_migrations');
  await pool.query('DROP FUNCTION IF EXISTS knotrack_migrate_test_fail_insert()');
  await pool.query(
    `DELETE FROM schema_migrations WHERE name IN ('900_test_ok.sql', '901_test_atomic.sql')`,
  );
});

afterAll(async () => {
  await closeTestPool();
});

describe('scripts/migrate.ts applyMigrations', () => {
  it('positive: applies a migration file and records it in schema_migrations', async () => {
    const dir = makeScratchMigrationsDir({
      '900_test_ok.sql': 'BEGIN;\nCREATE TABLE knotrack_migrate_test_ok (id int);\nCOMMIT;\n',
    });
    try {
      const client = await pool.connect();
      try {
        const appliedCount = await applyMigrations(client, dir);
        expect(appliedCount).toBe(1);
      } finally {
        client.release();
      }

      const table = await pool.query(
        `SELECT to_regclass('public.knotrack_migrate_test_ok') AS exists`,
      );
      expect(table.rows[0].exists).toBe('knotrack_migrate_test_ok');

      const row = await pool.query('SELECT name FROM schema_migrations WHERE name = $1', [
        '900_test_ok.sql',
      ]);
      expect(row.rowCount).toBe(1);

      // Second call is a no-op (already applied) — matches skip-logging path.
      const client2 = await pool.connect();
      try {
        const appliedAgain = await applyMigrations(client2, dir);
        expect(appliedAgain).toBe(0);
      } finally {
        client2.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // adversarial-review P2: the DDL used to commit (via its own embedded
  // BEGIN/COMMIT) before the separate schema_migrations INSERT — a failure
  // between the two left the schema changed with no record of it. This
  // forces exactly that INSERT to fail (via a trigger on schema_migrations
  // itself) and proves the DDL's effects are rolled back together with it
  // now that both run in one runner-controlled transaction.
  it('negative: a failure recording schema_migrations rolls back the DDL too, not just the bookkeeping row', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION knotrack_migrate_test_fail_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.name = '901_test_atomic.sql' THEN
          RAISE EXCEPTION 'forced failure for atomicity test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER trg_knotrack_migrate_test_fail
        BEFORE INSERT ON schema_migrations
        FOR EACH ROW EXECUTE FUNCTION knotrack_migrate_test_fail_insert();
    `);

    const dir = makeScratchMigrationsDir({
      '901_test_atomic.sql':
        'BEGIN;\nCREATE TABLE knotrack_migrate_test_atomic (id int);\nCOMMIT;\n',
    });
    try {
      const client = await pool.connect();
      try {
        await expect(applyMigrations(client, dir)).rejects.toThrow(/forced failure/i);
      } finally {
        client.release();
      }

      // The DDL must NOT have persisted — it was rolled back along with
      // the failed schema_migrations insert, exactly the property that
      // was missing before the fix (two separate transactions would have
      // left this table committed here).
      const table = await pool.query(
        `SELECT to_regclass('public.knotrack_migrate_test_atomic') AS exists`,
      );
      expect(table.rows[0].exists).toBeNull();

      const row = await pool.query('SELECT name FROM schema_migrations WHERE name = $1', [
        '901_test_atomic.sql',
      ]);
      expect(row.rowCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // CodeRabbit re-review Critical: LEADING_BEGIN used to be
  // `/^\s*BEGIN;\s*/i`, which only tolerated whitespace before `BEGIN;`. A
  // migration starting with a `-- ...` comment header (exactly
  // migrations/003_drift_flags_open_unique.sql's actual shape) failed
  // stripTransactionWrapper's own "must start with BEGIN;" check and threw,
  // even though the file is a perfectly valid BEGIN/COMMIT-wrapped
  // migration. This fixture models that file's header shape and proves the
  // migration now applies instead of throwing.
  it('positive: applies a migration file whose comment header precedes BEGIN; (models migrations/003)', async () => {
    const dir = makeScratchMigrationsDir({
      '903_test_comment_header.sql':
        '-- KnoTrack — 903_test_comment_header.sql\n' +
        '--\n' +
        '-- Multi-line SQL comment header, exactly the shape\n' +
        '-- migrations/003_drift_flags_open_unique.sql uses: several\n' +
        '-- `-- ...` comment lines and a blank line before BEGIN;.\n' +
        '\n' +
        'BEGIN;\n' +
        '\n' +
        'CREATE TABLE knotrack_migrate_test_comment_header (id int);\n' +
        '\n' +
        'COMMIT;\n',
    });
    try {
      const client = await pool.connect();
      try {
        const appliedCount = await applyMigrations(client, dir);
        expect(appliedCount).toBe(1);
      } finally {
        client.release();
      }

      const table = await pool.query(
        `SELECT to_regclass('public.knotrack_migrate_test_comment_header') AS exists`,
      );
      expect(table.rows[0].exists).toBe('knotrack_migrate_test_comment_header');

      const row = await pool.query('SELECT name FROM schema_migrations WHERE name = $1', [
        '903_test_comment_header.sql',
      ]);
      expect(row.rowCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.query('DROP TABLE IF EXISTS knotrack_migrate_test_comment_header');
      await pool.query(`DELETE FROM schema_migrations WHERE name = '903_test_comment_header.sql'`);
    }
  });

  // Directly exercises the actual shipped migration file, not just a
  // fixture modeled on it — the strongest possible proof this specific
  // regression (migrations/003 failing to apply) is fixed.
  it('positive: applies the actual migrations/003_drift_flags_open_unique.sql file against a scratch table standing in for drift_flags', async () => {
    // stripTransactionWrapper only strips BEGIN;/COMMIT; and runs whatever
    // DDL is left — it has no knowledge of table names — so a scratch
    // `drift_flags` table (dropped in this test's own cleanup, independent
    // of the shared afterEach above) lets the real file's
    // `CREATE UNIQUE INDEX ... ON drift_flags (...)` statement run as-is.
    await pool.query(`
      CREATE TABLE drift_flags_test_003 (
        item_id uuid,
        kind text,
        resolved_at timestamptz
      )
    `);
    const realFile = readFileSync(
      path.join(__dirname, '..', '..', 'migrations', '003_drift_flags_open_unique.sql'),
      'utf8',
    )
      .replace(/\bdrift_flags\b/g, 'drift_flags_test_003')
      // The real migration's index name would otherwise collide with the
      // one the real migrations/003_drift_flags_open_unique.sql already
      // created on this scratch database's actual drift_flags table —
      // Postgres index names are unique per schema regardless of table.
      .replace(/\buq_drift_flags_open_item_kind\b/g, 'uq_drift_flags_test_003_open_item_kind');
    // A distinct filename, not the real migration's name — this scratch
    // test database already has migrations/003_drift_flags_open_unique.sql
    // itself applied (from setting up the schema), so reusing that exact
    // name would just hit the "already applied" skip path instead of
    // actually exercising stripTransactionWrapper against this content.
    const testFileName = '905_test_real_003_content.sql';
    const dir = makeScratchMigrationsDir({ [testFileName]: realFile });
    try {
      const client = await pool.connect();
      try {
        const appliedCount = await applyMigrations(client, dir);
        expect(appliedCount).toBe(1);
      } finally {
        client.release();
      }

      const index = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = 'uq_drift_flags_test_003_open_item_kind'`,
      );
      expect(index.rowCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.query('DROP TABLE IF EXISTS drift_flags_test_003');
      await pool.query(`DELETE FROM schema_migrations WHERE name = $1`, [testFileName]);
    }
  });

  // Major fix: two concurrent applyMigrations calls could both read
  // schema_migrations, both pick the same pending file, and race applying
  // it. Proves the advisory lock is actually held for the duration of the
  // pass (a concurrent pg_try_advisory_lock on the same key fails while a
  // run is in flight) and is released once the pass completes (a
  // subsequent pg_try_advisory_lock then succeeds) — the exact property
  // that serializes two real concurrent runner invocations.
  it('holds the migration advisory lock for the whole pass and releases it once done', async () => {
    const dir = makeScratchMigrationsDir({
      '904_test_lock.sql':
        'BEGIN;\nSELECT pg_sleep(0.5);\nCREATE TABLE knotrack_migrate_test_lock (id int);\nCOMMIT;\n',
    });
    const client = await pool.connect();
    const checkerClient = await pool.connect();
    try {
      const runPromise = applyMigrations(client, dir);

      // Poll for the lock being held instead of sleeping a fixed delay —
      // a fixed delay can elapse before applyMigrations actually acquires
      // the lock under load, letting pg_try_advisory_lock spuriously
      // succeed and failing this test even when the runner is correct.
      // Release the lock after every successful probe so a slow-to-start
      // run doesn't get falsely flagged, and only proceed once a probe
      // observes contention (another session actually holds the lock).
      const deadline = Date.now() + 5_000;
      let lockObserved = false;
      while (Date.now() < deadline) {
        const probe = await checkerClient.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS acquired',
          [MIGRATION_ADVISORY_LOCK_KEY],
        );
        if (!probe.rows[0]?.acquired) {
          lockObserved = true;
          break;
        }
        await checkerClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lockObserved).toBe(true);

      const appliedCount = await runPromise;
      expect(appliedCount).toBe(1);

      const afterRun = await checkerClient.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [MIGRATION_ADVISORY_LOCK_KEY],
      );
      expect(afterRun.rows[0]?.acquired).toBe(true);
      await checkerClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
      checkerClient.release();
      rmSync(dir, { recursive: true, force: true });
      await pool.query('DROP TABLE IF EXISTS knotrack_migrate_test_lock');
      await pool.query(`DELETE FROM schema_migrations WHERE name = '904_test_lock.sql'`);
    }
  });

  it('negative: a migration file without BEGIN;/COMMIT; fails loudly instead of running unwrapped', async () => {
    const dir = makeScratchMigrationsDir({
      '902_test_no_wrapper.sql': 'CREATE TABLE knotrack_migrate_test_no_wrapper (id int);\n',
    });
    try {
      const client = await pool.connect();
      try {
        await expect(applyMigrations(client, dir)).rejects.toThrow(
          /must start with "BEGIN;".*and end with "COMMIT;"/,
        );
      } finally {
        client.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.query('DROP TABLE IF EXISTS knotrack_migrate_test_no_wrapper');
      await pool.query(`DELETE FROM schema_migrations WHERE name = '902_test_no_wrapper.sql'`);
    }
  });
});
