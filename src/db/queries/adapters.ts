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
  await db.query(
    `INSERT INTO adapters (project_id, type, encrypted_credential, config)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, type)
     DO UPDATE SET encrypted_credential = EXCLUDED.encrypted_credential,
                   config = EXCLUDED.config`,
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
