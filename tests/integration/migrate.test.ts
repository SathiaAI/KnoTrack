import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../scripts/migrate.js';
import { closeTestPool, getTestPool } from './helpers.js';

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

  it('negative: a migration file without BEGIN;/COMMIT; fails loudly instead of running unwrapped', async () => {
    const dir = makeScratchMigrationsDir({
      '902_test_no_wrapper.sql': 'CREATE TABLE knotrack_migrate_test_no_wrapper (id int);\n',
    });
    try {
      const client = await pool.connect();
      try {
        await expect(applyMigrations(client, dir)).rejects.toThrow(
          /must start with "BEGIN;" and end with "COMMIT;"/,
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
