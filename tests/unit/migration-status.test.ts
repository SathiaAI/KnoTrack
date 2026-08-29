// Unit tests for the read-only pending-migrations guard (docs/ROADMAP.md
// T3.8). Uses a scratch migrations directory (real files on disk, matching
// tests/integration/migrate.test.ts's own fixture pattern) and a small fake
// QueryableClient (matching this repo's existing vi.fn()-based fake-object
// test style, e.g. tests/unit/auth.test.ts) rather than a live Postgres
// connection — the behavior under test is the pure "which files on disk
// are absent from these rows" diff, not anything Postgres-specific, so a
// fake that returns exactly the shapes real query results have is a
// faithful stand-in.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPendingMigrationFiles, type QueryableClient } from '../../src/db/migration-status.js';

let scratchDir: string | undefined;

function makeScratchMigrationsDir(files: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'knotrack-migration-status-test-'));
  for (const name of files) {
    writeFileSync(path.join(dir, name), '-- unused by this test\n', 'utf8');
  }
  scratchDir = dir;
  return dir;
}

afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

/** A fake client that answers exactly the two queries
 * getPendingMigrationFiles issues, with no real database involved. */
function fakeClient(options: { tableExists: boolean; appliedNames: string[] }): QueryableClient {
  return {
    query<T extends Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
      if (text.includes('to_regclass')) {
        const row = { exists: options.tableExists ? 'schema_migrations' : null };
        return Promise.resolve({ rows: [row as unknown as T] });
      }
      if (text.includes('SELECT name FROM schema_migrations')) {
        const rows = options.appliedNames.map((name) => ({ name }) as unknown as T);
        return Promise.resolve({ rows });
      }
      throw new Error(`unexpected query in fakeClient: ${text}`);
    },
  };
}

describe('getPendingMigrationFiles', () => {
  it('returns an empty array when every migration file is already applied', async () => {
    const dir = makeScratchMigrationsDir([
      '001_init.sql',
      '001_init.down.sql',
      '002_next.sql',
      '002_next.down.sql',
    ]);
    const client = fakeClient({
      tableExists: true,
      appliedNames: ['001_init.sql', '002_next.sql'],
    });

    await expect(getPendingMigrationFiles(client, dir)).resolves.toEqual([]);
  });

  it('treats every migration file on disk as pending when schema_migrations does not exist at all', async () => {
    const dir = makeScratchMigrationsDir([
      '001_init.sql',
      '001_init.down.sql',
      '002_next.sql',
      '003_later.sql',
    ]);
    const client = fakeClient({ tableExists: false, appliedNames: [] });

    // .down.sql files are always excluded, regardless of table existence.
    await expect(getPendingMigrationFiles(client, dir)).resolves.toEqual([
      '001_init.sql',
      '002_next.sql',
      '003_later.sql',
    ]);
  });

  it('returns only the files missing from schema_migrations when some are applied', async () => {
    const dir = makeScratchMigrationsDir([
      '001_init.sql',
      '001_init.down.sql',
      '002_next.sql',
      '002_next.down.sql',
      '003_later.sql',
      '004_latest.sql',
    ]);
    const client = fakeClient({
      tableExists: true,
      appliedNames: ['001_init.sql', '002_next.sql'],
    });

    await expect(getPendingMigrationFiles(client, dir)).resolves.toEqual([
      '003_later.sql',
      '004_latest.sql',
    ]);
  });

  it('never issues a query beyond the two read-only checks (no CREATE TABLE, no lock)', async () => {
    const dir = makeScratchMigrationsDir(['001_init.sql']);
    const issuedQueries: string[] = [];
    const client: QueryableClient = {
      query<T extends Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
        issuedQueries.push(text);
        if (text.includes('to_regclass')) {
          return Promise.resolve({ rows: [{ exists: null } as unknown as T] });
        }
        return Promise.resolve({ rows: [] });
      },
    };

    await getPendingMigrationFiles(client, dir);

    expect(issuedQueries).toHaveLength(1); // table doesn't exist — short-circuits before the second query
    for (const q of issuedQueries) {
      expect(q).not.toMatch(/CREATE TABLE|pg_advisory_lock|INSERT INTO/i);
    }
  });
});
