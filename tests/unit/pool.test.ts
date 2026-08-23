import { describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import type { Config } from '../../src/config/env.js';

// adversarial-review security-2 / data_privacy-1: rejectUnauthorized used to
// be hardcoded to false whenever SSL was required, silently accepting any
// TLS certificate. These tests pin the fixed behavior: verification is on
// by default and only the explicit opt-out env-derived config disables it.
describe('createPool TLS config (TRD §... / adversarial-review security-2)', () => {
  const baseConfig: Config = {
    databaseUrl: 'postgres://user:pass@localhost:5432/db',
    apiTokens: ['kt_test'],
    encryptionKey: Buffer.alloc(32),
    nodeEnv: 'production',
    port: 8080,
    host: '0.0.0.0',
    databaseSslMode: 'require',
    dbSslRejectUnauthorized: true,
    dbStatementTimeoutMs: 30000,
    dbPoolMax: 10,
    driftScanTrackCap: 500,
    driftScanItemCap: 5000,
    driftScanTimeoutMs: 5000,
    roadmapTrackCap: 200,
    roadmapItemPerTrackCap: 100,
    staleTrackDays: 14,
    nextStepsLimit: 5,
    githubSyncTimeoutMs: 8000,
    linearSyncTimeoutMs: 8000,
    logLevel: 'info',
  };

  it('defaults to verifying the server TLS certificate when SSL is required', () => {
    const pool = createPool(baseConfig);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true });
    void pool.end();
  });

  it('only disables verification when dbSslRejectUnauthorized is explicitly false', () => {
    const pool = createPool({ ...baseConfig, dbSslRejectUnauthorized: false });
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: false });
    void pool.end();
  });

  it('sets no ssl option at all when SSL mode is disable', () => {
    const pool = createPool({ ...baseConfig, databaseSslMode: 'disable' });
    expect(pool.options.ssl).toBeUndefined();
    void pool.end();
  });

  it('applies dbStatementTimeoutMs as the pg statement_timeout', () => {
    const pool = createPool({ ...baseConfig, dbStatementTimeoutMs: 12345 });
    expect(pool.options.statement_timeout).toBe(12345);
    void pool.end();
  });
});
