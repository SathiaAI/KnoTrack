// Shared TLS connection-config helpers for src/db/pool.ts and
// scripts/migrate.ts (docs/TRD.md §7, KNOTRACK_DB_SSL_CA_BASE64).
//
// scripts/migrate.ts deliberately doesn't go through
// loadConfig()/createPool() — a migration run shouldn't have to supply
// KNOTRACK_API_TOKENS/KNOTRACK_ENCRYPTION_KEY just to connect — but both
// call sites need identical protection against the same two TLS pitfalls
// (PR #11 review findings, both independently reproduced against the
// actual `pg`/`pg-connection-string` behavior before fixing):
//
// 1. node-postgres parses `sslmode`/`sslcert`/`sslkey`/`sslrootcert`/
//    `sslnegotiation`/`uselibpqcompat` out of the connection string itself
//    and uses them to build its OWN `ssl` option, silently replacing
//    whatever `ssl` object the caller passed in — e.g. a DATABASE_URL
//    containing `?sslmode=no-verify` overrides an explicit
//    `rejectUnauthorized: true` with `false`, and `?sslmode=require` (with
//    no root cert of its own) drops a pinned `ca` entirely. Confirmed
//    directly against node_modules/pg 8.13.1's connectionParameters.ssl.
// 2. A malformed KNOTRACK_DB_SSL_CA_BASE64 (bad base64, or valid base64
//    that isn't a real certificate) must fail loudly at startup, not
//    decode into an empty/garbage string that silently falls through to
//    unauthenticated TLS.
import { X509Certificate } from 'node:crypto';

const SSL_QUERY_PARAMS = [
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslnegotiation',
  'sslpassword',
  'uselibpqcompat',
];

/**
 * Resolves the effective TLS mode the same way everywhere it's computed
 * (src/config/env.ts's loadConfig() and scripts/migrate.ts): an explicit
 * DATABASE_SSL_MODE always wins; otherwise 'require' in production,
 * 'disable' everywhere else. PR #11 review finding (Codex): migrate.ts
 * used to hardcode 'disable' as its default regardless of NODE_ENV,
 * silently skipping TLS during migrations on a production deploy that
 * never set DATABASE_SSL_MODE explicitly, even though the app's own pool
 * would enforce TLS.
 */
export function resolveSslMode(
  nodeEnv: string | undefined,
  explicitMode: string | undefined,
): 'require' | 'disable' {
  if (explicitMode === 'require' || explicitMode === 'disable') {
    return explicitMode;
  }
  return nodeEnv === 'production' ? 'require' : 'disable';
}

/**
 * Removes every TLS-related query parameter from a Postgres connection
 * string, so that DATABASE_SSL_MODE / KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED /
 * KNOTRACK_DB_SSL_CA_BASE64 (docs/TRD.md §7) remain the sole source of
 * truth for TLS behavior — never silently overridden by a query parameter
 * pg's own connection-string parser recognizes.
 */
export function stripSslQueryParams(connectionString: string): string {
  const url = new URL(connectionString);
  for (const param of SSL_QUERY_PARAMS) {
    url.searchParams.delete(param);
  }
  return url.toString();
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes and strictly validates KNOTRACK_DB_SSL_CA_BASE64. Throws on
 * malformed base64 or on base64 that decodes to something other than a
 * parseable X.509 certificate — Node's Buffer.from(str, 'base64') is
 * lenient and silently drops invalid characters instead of throwing, so a
 * regex/length check alone isn't enough; X509Certificate is what actually
 * confirms the decoded bytes are a real certificate rather than
 * base64-encoded garbage (e.g. `aGVsbG8=`, which decodes to "hello").
 */
export function decodeAndValidateSslCa(base64Value: string): string {
  if (!STRICT_BASE64.test(base64Value)) {
    throw new Error('KNOTRACK_DB_SSL_CA_BASE64 must be valid, unwrapped (single-line) base64');
  }
  const pem = Buffer.from(base64Value, 'base64').toString('utf8');
  try {
    // Constructed only to validate: parses and throws on invalid input.
    new X509Certificate(pem);
  } catch (cause) {
    throw new Error('KNOTRACK_DB_SSL_CA_BASE64 does not decode to a valid X.509 certificate', {
      cause,
    });
  }
  return pem;
}
