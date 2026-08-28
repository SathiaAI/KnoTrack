// zod schema for process.env -> typed Config object.
// See docs/TRD.md §7 for the full env var table this mirrors.
import { z } from 'zod';
import { decodeAndValidateSslCa, resolveSslMode } from '../db/ssl-config.js';

const base64Bytes = (expectedLength: number) =>
  z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === expectedLength;
      } catch {
        return false;
      }
    },
    { message: `must be base64 encoding exactly ${expectedLength} bytes` },
  );

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  KNOTRACK_API_TOKENS: z
    .string()
    .min(1, 'KNOTRACK_API_TOKENS is required and must not be empty')
    .transform((value) =>
      value
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    )
    .refine((tokens) => tokens.length > 0, {
      message: 'KNOTRACK_API_TOKENS must contain at least one token',
    }),
  KNOTRACK_ENCRYPTION_KEY: base64Bytes(32),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_SSL_MODE: z.enum(['require', 'disable']).optional(),
  // Defaults to true: verify the Postgres server's TLS certificate against
  // trusted CAs. The only reason to ever set this to false is a broken/
  // self-signed local dev cert — see docs/TRD.md §... (adversarial-review
  // finding security-2/data_privacy-1: this used to be hardcoded to false
  // whenever SSL was required, silently accepting any certificate).
  KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Base64-encoded PEM certificate for a managed Postgres that presents a
  // self-signed cert even on its private/internal network (Railway's
  // postgres-ssl image is the motivating case). When set, the pool trusts
  // exactly this certificate and always verifies against it — a real fix
  // for the MITM gap KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED=false leaves open,
  // rather than disabling verification. Optional: every other deploy
  // target (Supabase, Fly.io, local dev) has no reason to set this.
  //
  // Parsed (not just shape-checked) via decodeAndValidateSslCa
  // (src/db/ssl-config.ts, shared with scripts/migrate.ts) — PR #11 review
  // finding: a plain base64-shape check accepts base64-encoded non-PEM
  // garbage (e.g. `aGVsbG8=`, which decodes to "hello"), which used to
  // fail late and confusingly at TLS-handshake time instead of at startup
  // config validation. This transform yields the decoded, verified PEM
  // directly — loadConfig() below uses it as-is, no separate decode step.
  KNOTRACK_DB_SSL_CA_BASE64: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .transform((value, ctx): string | undefined => {
      if (value === undefined) return undefined;
      try {
        return decodeAndValidateSslCa(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'invalid KNOTRACK_DB_SSL_CA_BASE64',
        });
        return z.NEVER;
      }
    }),
  KNOTRACK_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  KNOTRACK_DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  KNOTRACK_DRIFT_SCAN_TRACK_CAP: z.coerce.number().int().positive().default(500),
  KNOTRACK_DRIFT_SCAN_ITEM_CAP: z.coerce.number().int().positive().default(5000),
  KNOTRACK_DRIFT_SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  KNOTRACK_ROADMAP_TRACK_CAP: z.coerce.number().int().positive().default(200),
  KNOTRACK_ROADMAP_ITEM_PER_TRACK_CAP: z.coerce.number().int().positive().default(100),
  KNOTRACK_STALE_TRACK_DAYS: z.coerce.number().int().positive().default(14),
  KNOTRACK_NEXT_STEPS_LIMIT: z.coerce.number().int().positive().default(5),
  KNOTRACK_GITHUB_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  KNOTRACK_LINEAR_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = {
  databaseUrl: string;
  apiTokens: string[];
  encryptionKey: Buffer;
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  databaseSslMode: 'require' | 'disable';
  dbSslRejectUnauthorized: boolean;
  dbSslCa: string | undefined;
  dbStatementTimeoutMs: number;
  dbPoolMax: number;
  driftScanTrackCap: number;
  driftScanItemCap: number;
  driftScanTimeoutMs: number;
  roadmapTrackCap: number;
  roadmapItemPerTrackCap: number;
  staleTrackDays: number;
  nextStepsLimit: number;
  githubSyncTimeoutMs: number;
  linearSyncTimeoutMs: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const data = parsed.data;
  const nodeEnv = data.NODE_ENV;
  const databaseSslMode = resolveSslMode(nodeEnv, data.DATABASE_SSL_MODE);

  return {
    databaseUrl: data.DATABASE_URL,
    apiTokens: data.KNOTRACK_API_TOKENS,
    encryptionKey: Buffer.from(data.KNOTRACK_ENCRYPTION_KEY, 'base64'),
    nodeEnv,
    port: data.PORT,
    host: data.HOST,
    databaseSslMode,
    dbSslRejectUnauthorized: data.KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED,
    dbSslCa: data.KNOTRACK_DB_SSL_CA_BASE64,
    dbStatementTimeoutMs: data.KNOTRACK_DB_STATEMENT_TIMEOUT_MS,
    dbPoolMax: data.KNOTRACK_DB_POOL_MAX,
    driftScanTrackCap: data.KNOTRACK_DRIFT_SCAN_TRACK_CAP,
    driftScanItemCap: data.KNOTRACK_DRIFT_SCAN_ITEM_CAP,
    driftScanTimeoutMs: data.KNOTRACK_DRIFT_SCAN_TIMEOUT_MS,
    roadmapTrackCap: data.KNOTRACK_ROADMAP_TRACK_CAP,
    roadmapItemPerTrackCap: data.KNOTRACK_ROADMAP_ITEM_PER_TRACK_CAP,
    staleTrackDays: data.KNOTRACK_STALE_TRACK_DAYS,
    nextStepsLimit: data.KNOTRACK_NEXT_STEPS_LIMIT,
    githubSyncTimeoutMs: data.KNOTRACK_GITHUB_SYNC_TIMEOUT_MS,
    linearSyncTimeoutMs: data.KNOTRACK_LINEAR_SYNC_TIMEOUT_MS,
    logLevel: data.LOG_LEVEL,
  };
}
