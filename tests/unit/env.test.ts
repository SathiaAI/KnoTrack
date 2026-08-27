import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

// KNOTRACK_DB_SSL_CA_BASE64 (Railway self-signed Postgres CA pinning) —
// docs/TRD.md §7. The rest of loadConfig's parsing is already exercised
// indirectly by every test that boots a real config; this file covers
// just the new variable's decode/validation behavior in isolation.
describe('loadConfig — KNOTRACK_DB_SSL_CA_BASE64', () => {
  const REQUIRED_ENV = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    KNOTRACK_API_TOKENS: 'kt_test',
    KNOTRACK_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  };

  it('leaves dbSslCa undefined when the variable is unset', () => {
    const config = loadConfig({ ...REQUIRED_ENV });
    expect(config.dbSslCa).toBeUndefined();
  });

  it('leaves dbSslCa undefined when the variable is set to an empty string', () => {
    const config = loadConfig({ ...REQUIRED_ENV, KNOTRACK_DB_SSL_CA_BASE64: '' });
    expect(config.dbSslCa).toBeUndefined();
  });

  it('decodes a valid base64-encoded PEM into dbSslCa', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nfakecertdata\n-----END CERTIFICATE-----\n';
    const config = loadConfig({
      ...REQUIRED_ENV,
      KNOTRACK_DB_SSL_CA_BASE64: Buffer.from(pem, 'utf8').toString('base64'),
    });
    expect(config.dbSslCa).toBe(pem);
  });

  it('rejects a KNOTRACK_DB_SSL_CA_BASE64 value that is not valid base64', () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENV, KNOTRACK_DB_SSL_CA_BASE64: 'not valid base64 !!! ###' }),
    ).toThrow(/KNOTRACK_DB_SSL_CA_BASE64/);
  });
});
