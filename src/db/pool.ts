// pg.Pool singleton, sized from KNOTRACK_DB_POOL_MAX (TRD §6.2).
import { Pool, type PoolConfig } from 'pg';
import type { Config } from '../config/env.js';

let pool: Pool | undefined;

export function createPool(config: Config, overrides: Partial<PoolConfig> = {}): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // statement_timeout bounds how long any single query can run before
    // Postgres itself cancels it, so a slow/deadlocked query can't hang a
    // request (and the connection it's holding) indefinitely.
    statement_timeout: config.dbStatementTimeoutMs,
    ...overrides,
  };
  if (config.databaseSslMode === 'require') {
    // rejectUnauthorized defaults to true (verify the server's TLS cert
    // against trusted CAs) — only KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED=false
    // disables it, for a broken/self-signed local dev certificate. Never
    // hardcode this to false: doing so keeps the channel encrypted but
    // accepts any certificate, which is silently vulnerable to MITM.
    poolConfig.ssl = { rejectUnauthorized: config.dbSslRejectUnauthorized };
  }
  return new Pool(poolConfig);
}

/** Process-wide singleton, initialized once at boot via initPool(). */
export function initPool(config: Config): Pool {
  pool = createPool(config);
  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('DB pool not initialized — call initPool(config) at process startup');
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
