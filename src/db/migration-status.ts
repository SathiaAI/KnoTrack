// Read-only pending-migrations guard (docs/ROADMAP.md T3.8).
//
// Production once ran for a while with a completely missing schema (zero
// tables) while still reporting /health as `200 ok` and accepting traffic,
// because the platform-level step that was supposed to run migrations
// before start silently never ran (see docs/ROADMAP.md T3's status). This
// module is the other half of that fix: it answers "is the schema behind?"
// so src/index.ts can refuse to start when it is, regardless of whether the
// migration step ran, was skipped, or fails in some new way.
//
// Deliberately independent of scripts/migrate.ts's `applyMigrations` rather
// than sharing code with it: that runner is already correct and proven in
// production, and this check must stay strictly read-only (it must never
// create `schema_migrations`, apply a migration, or take the migration
// advisory lock — see scripts/migrate.ts's own MIGRATION_ADVISORY_LOCK_KEY),
// so a small independent duplicate of its "which files are pending" logic
// is safer than risking that file's correctness for a little deduplication.
import { readdirSync } from 'node:fs';

/**
 * The minimal shape this module needs from a pg client — a `Pool`,
 * `PoolClient`, or `Client` all satisfy this structurally, and so does a
 * lightweight test double, without either side needing an adapter.
 */
export interface QueryableClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Returns the `migrations/*.sql` filenames (excluding `*.down.sql`, listed
 * in the same order applyMigrations applies them) that are not yet recorded
 * as applied in `schema_migrations`.
 *
 * Read-only: never creates `schema_migrations`, never applies a migration,
 * never takes the migration advisory lock. If `schema_migrations` doesn't
 * exist at all yet, every migration file on disk counts as pending — that
 * is exactly the "brand new / never migrated" database this guard exists
 * to catch, not an error condition to throw on.
 */
export async function getPendingMigrationFiles(
  client: QueryableClient,
  migrationsDir: string,
): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  // Deliberately unqualified (relies on the connection's search_path),
  // matching the equally-unqualified `SELECT name FROM schema_migrations`
  // below and scripts/migrate.ts's own unqualified `CREATE TABLE IF NOT
  // EXISTS schema_migrations`. Hardcoding `public.schema_migrations` here
  // (as a previous version of this check did) would silently disagree
  // with the runner whenever the connecting role has a non-default
  // search_path: the table would exist and be fully migrated, just not
  // in `public`, and this check would report "table doesn't exist" and
  // treat every migration as pending — adversarial PR review finding.
  const tableCheck = await client.query<{ exists: string | null }>(
    "SELECT to_regclass('schema_migrations') AS exists",
  );
  const tableExists = tableCheck.rows[0]?.exists != null;
  if (!tableExists) {
    return files;
  }

  const appliedResult = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map((r) => r.name));

  return files.filter((f) => !applied.has(f));
}
