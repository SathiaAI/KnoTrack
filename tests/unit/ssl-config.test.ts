import { describe, expect, it } from 'vitest';
import {
  decodeAndValidateSslCa,
  resolveSslMode,
  stripSslQueryParams,
} from '../../src/db/ssl-config.js';
import { generateTestCertificatePem } from '../helpers/test-certificate.js';

// A real, freshly-generated self-signed cert (not a fixed committed one —
// generated at test time so this file doesn't hold a long-lived private
// key's public counterpart around indefinitely; only the certificate,
// never a key, is used here anyway).
const REAL_CERT_PEM = generateTestCertificatePem();

describe('resolveSslMode (PR #11 review: migrate.ts NODE_ENV default)', () => {
  it('uses the explicit mode when DATABASE_SSL_MODE is set, regardless of NODE_ENV', () => {
    expect(resolveSslMode('development', 'require')).toBe('require');
    expect(resolveSslMode('production', 'disable')).toBe('disable');
  });

  it('defaults to require when NODE_ENV is production and no explicit mode is set', () => {
    expect(resolveSslMode('production', undefined)).toBe('require');
  });

  it('defaults to disable when NODE_ENV is not production and no explicit mode is set', () => {
    expect(resolveSslMode('development', undefined)).toBe('disable');
    expect(resolveSslMode('test', undefined)).toBe('disable');
    expect(resolveSslMode(undefined, undefined)).toBe('disable');
  });
});

describe('stripSslQueryParams (PR #11 review: DATABASE_URL SSL params overriding a pinned CA)', () => {
  it('leaves a URL with no SSL-related query params unchanged in substance', () => {
    const url = 'postgres://user:pass@localhost:5432/db?foo=bar';
    expect(stripSslQueryParams(url)).toBe(url);
  });

  it.each([
    'ssl',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslnegotiation',
    'sslpassword',
    'uselibpqcompat',
  ])('strips the %s query parameter', (param) => {
    const stripped = stripSslQueryParams(`postgres://user:pass@localhost:5432/db?${param}=x`);
    expect(new URL(stripped).searchParams.has(param)).toBe(false);
  });

  it('preserves unrelated query params while stripping SSL-related ones', () => {
    const stripped = stripSslQueryParams(
      'postgres://user:pass@localhost:5432/db?foo=bar&sslmode=require&baz=qux',
    );
    const params = new URL(stripped).searchParams;
    expect(params.get('foo')).toBe('bar');
    expect(params.get('baz')).toBe('qux');
    expect(params.has('sslmode')).toBe(false);
  });

  it("actually prevents pg's connection-string parser from overriding a pinned ssl option", async () => {
    // Direct regression test for the PR #11 finding: without stripping,
    // ?sslmode=no-verify silently flips an explicit
    // rejectUnauthorized: true to false.
    //
    // pg.Client computes this at construction time on a `connectionParameters`
    // property that @types/pg doesn't declare (verified present at runtime
    // against pg 8.13.1) — narrow, local cast to read it rather than `any`.
    const { Client } = await import('pg');
    const readClientSsl = (client: InstanceType<typeof Client>): unknown =>
      (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
    const raw = 'postgres://user:pass@localhost:5432/db?sslmode=no-verify';
    const withStripping = new Client({
      connectionString: stripSslQueryParams(raw),
      ssl: { ca: 'pinned-ca', rejectUnauthorized: true },
    });
    expect(readClientSsl(withStripping)).toEqual({
      ca: 'pinned-ca',
      rejectUnauthorized: true,
    });

    const withoutStripping = new Client({
      connectionString: raw,
      ssl: { ca: 'pinned-ca', rejectUnauthorized: true },
    });
    // Documents the actual vulnerable behavior this fix avoids — pg
    // silently drops the pinned ca and forces rejectUnauthorized: false.
    expect(readClientSsl(withoutStripping)).toEqual({ rejectUnauthorized: false });
  });
});

describe('decodeAndValidateSslCa (PR #11 review: strict PEM validation)', () => {
  it('decodes a real, valid certificate', () => {
    const base64 = Buffer.from(REAL_CERT_PEM, 'utf8').toString('base64');
    expect(decodeAndValidateSslCa(base64)).toBe(REAL_CERT_PEM);
  });

  it('rejects malformed (non-base64) input instead of silently decoding to an empty string', () => {
    expect(() => decodeAndValidateSslCa('%%%%')).toThrow(/valid.*base64/i);
  });

  it('rejects valid base64 that decodes to non-certificate text', () => {
    const base64 = Buffer.from('hello', 'utf8').toString('base64'); // "aGVsbG8="
    expect(() => decodeAndValidateSslCa(base64)).toThrow(/valid X\.509 certificate/i);
  });

  it('rejects a well-formed-looking but bogus PEM body', () => {
    const fakePem = '-----BEGIN CERTIFICATE-----\nfakecertdata\n-----END CERTIFICATE-----\n';
    const base64 = Buffer.from(fakePem, 'utf8').toString('base64');
    expect(() => decodeAndValidateSslCa(base64)).toThrow(/valid X\.509 certificate/i);
  });
});
