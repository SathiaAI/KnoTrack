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
