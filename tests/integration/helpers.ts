// Shared test setup: a pg.Pool against the real local scratch Postgres
// database (migrations/001_init.sql already applied — see scripts/migrate.ts),
// a matching Config, and a truncate helper for test isolation.
import { Pool } from 'pg';
import type { Config } from '../../src/config/env.js';

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://knotrack_app:knotrack_dev_pw@127.0.0.1:5432/knotrack_scratch';

let pool: Pool | undefined;

export function getTestPool(): Pool {
  pool ??= new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  return pool;
}

export function getTestConfig(): Config {
  return {
    databaseUrl: TEST_DATABASE_URL,
    apiTokens: ['kt_test_token'],
    encryptionKey: Buffer.from('01234567890123456789012345678901', 'utf8').subarray(0, 32),
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    databaseSslMode: 'disable',
    dbSslRejectUnauthorized: true,
    dbStatementTimeoutMs: 30000,
    dbPoolMax: 5,
    driftScanTrackCap: 500,
    driftScanItemCap: 5000,
    driftScanTimeoutMs: 5000,
    roadmapTrackCap: 200,
    roadmapItemPerTrackCap: 100,
    staleTrackDays: 14,
    nextStepsLimit: 5,
    githubSyncTimeoutMs: 8000,
    linearSyncTimeoutMs: 8000,
    logLevel: 'error',
  };
}

/** Wipes every table between tests so each test starts from a clean
 * slate, without dropping/recreating the schema (the migration stays
 * applied for the whole test run). */
export async function truncateAll(): Promise<void> {
  const p = getTestPool();
  await p.query(
    `TRUNCATE TABLE
       drift_flags, decisions, events, api_tokens,
       item_dependencies, items,
       track_dependencies, tracks,
       adapters, projects
     RESTART IDENTITY CASCADE`,
  );
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';
