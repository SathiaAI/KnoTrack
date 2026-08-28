import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { generateTestCertificatePem } from '../helpers/test-certificate.js';

// KNOTRACK_DB_SSL_CA_BASE64 (Railway self-signed Postgres CA pinning) —
// docs/TRD.md §7. The rest of loadConfig's parsing is already exercised
// indirectly by every test that boots a real config; this file covers
// just the new variable's decode/validation behavior in isolation.
//
// PR #11 review: the schema now validates the decoded value is a real
// X.509 certificate (src/db/ssl-config.ts's decodeAndValidateSslCa), so
// this suite needs a real generated cert rather than placeholder PEM text.
const REAL_CERT_PEM = generateTestCertificatePem();

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
    const config = loadConfig({
      ...REQUIRED_ENV,
      KNOTRACK_DB_SSL_CA_BASE64: Buffer.from(REAL_CERT_PEM, 'utf8').toString('base64'),
    });
    expect(config.dbSslCa).toBe(REAL_CERT_PEM);
  });

  it('rejects a KNOTRACK_DB_SSL_CA_BASE64 value that is not valid base64', () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENV, KNOTRACK_DB_SSL_CA_BASE64: 'not valid base64 !!! ###' }),
    ).toThrow(/KNOTRACK_DB_SSL_CA_BASE64/);
  });

  it('rejects a KNOTRACK_DB_SSL_CA_BASE64 value that is valid base64 but not a real certificate', () => {
    // PR #11 review (CodeRabbit): a plain base64-shape check let non-PEM
    // garbage like `aGVsbG8=` ("hello") through; decodeAndValidateSslCa
    // now parses it with X509Certificate and rejects non-certificate input.
    expect(() =>
      loadConfig({
        ...REQUIRED_ENV,
        KNOTRACK_DB_SSL_CA_BASE64: Buffer.from('hello', 'utf8').toString('base64'),
      }),
    ).toThrow(/valid X\.509 certificate/i);
  });
});
