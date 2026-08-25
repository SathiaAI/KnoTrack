// `adapters` table access. Non-secret config (repo, team_id, etc.) is
// stored in `config jsonb`; the encrypted secret is packed into
// `encrypted_credential bytea` by src/crypto/credential-cipher.ts.
// See that module's header comment for why this doesn't match TRD §5's
// Appendix A `adapter_credentials` table shape.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export async function upsertAdapter(
  db: Queryable,
  input: {
    projectId: string;
    type: 'github' | 'linear';
    encryptedCredential: Buffer;
    config: Record<string, unknown>;
  },
): Promise<void> {
  // key_version: CodeRabbit finding on PR #4 — leaving this to the
  // column's own DEFAULT 1 only works for the very first adapter ever
  // inserted. Once a rotation has bumped every existing row to
  // generation N, a brand-new row (a new adapter, or a re-registration
  // that DO UPDATEs an existing one) is encrypted with whatever key is
  // *currently* configured — which, by the rotation runbook in TRD §5,
  // is always generation N by the time the server is back up and
  // accepting registrations again. Stamping it with the column default
  // of 1 instead of N would silently desynchronize it from every other
  // row, so the next rotation would bump it to N+1 while the untouched
  // rows go to N+2 — both now on the same actual key, but disagreeing
  // about which "generation" that is. Deriving key_version from
  // MAX(key_version) across the table (falling back to 1 when the table
  // is empty) keeps every row's stamp in sync with whatever the last
  // rotation left behind, with no separate generation-counter table to
  // maintain.
  await db.query(
    `INSERT INTO adapters (project_id, type, encrypted_credential, config, key_version)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(key_version) FROM adapters), 1))
     ON CONFLICT (project_id, type)
     DO UPDATE SET encrypted_credential = EXCLUDED.encrypted_credential,
                   config = EXCLUDED.config,
                   key_version = EXCLUDED.key_version`,
    [input.projectId, input.type, input.encryptedCredential, JSON.stringify(input.config)],
  );
}

export interface AdapterRow {
  id: string;
  project_id: string;
  type: 'github' | 'linear';
  encrypted_credential: Buffer;
  config: Record<string, unknown>;
  key_version: number;
  created_at: Date;
}

export async function listAdaptersForProject(
  db: Queryable,
  projectId: string,
): Promise<AdapterRow[]> {
  const result = await db.query<AdapterRow>(`SELECT * FROM adapters WHERE project_id = $1`, [
    projectId,
  ]);
  return result.rows;
}

/** Every adapter row across every project — used only by
 * scripts/rotate-encryption-key.ts, which has to re-encrypt every stored
 * credential regardless of which project it belongs to. No other call
 * site needs an unscoped read across projects. */
export async function listAllAdapters(db: Queryable): Promise<AdapterRow[]> {
  const result = await db.query<AdapterRow>(`SELECT * FROM adapters ORDER BY id`);
  return result.rows;
}

/** Overwrites one adapter row's encrypted credential and bumps its
 * key_version — the write half of a key rotation
 * (scripts/rotate-encryption-key.ts). Never touches `config`. */
export async function updateAdapterEncryptedCredential(
  db: Queryable,
  id: string,
  encryptedCredential: Buffer,
  keyVersion: number,
): Promise<void> {
  await db.query(`UPDATE adapters SET encrypted_credential = $2, key_version = $3 WHERE id = $1`, [
    id,
    encryptedCredential,
    keyVersion,
  ]);
}
