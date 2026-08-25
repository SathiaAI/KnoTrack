#!/usr/bin/env tsx
// Rotates KNOTRACK_ENCRYPTION_KEY across every stored adapter credential
// (docs/TRD.md §5 "Known gap" / docs/ROADMAP.md's encryption-key-rotation
// T9.x item). Manual, operator-run, offline-key-swap rotation — KnoTrack
// v1 never supports more than one *active* encryption key on a running
// server; this script is what an operator runs once, between shutting the
// server down (or otherwise pausing writes to `adapters`) and redeploying
// it with the new key.
//
// Usage:
//   KNOTRACK_ENCRYPTION_KEY_NEW=$(openssl rand -base64 32) npm run rotate-encryption-key
//
// Reads the CURRENT key from KNOTRACK_ENCRYPTION_KEY (same as every other
// entrypoint, via loadConfig()) and the NEW key from
// KNOTRACK_ENCRYPTION_KEY_NEW (base64, exactly 32 bytes — same shape,
// deliberately not reusing loadConfig()'s schema for a second key since
// only this script ever needs one). Decrypts every `adapters` row with
// the current key, re-encrypts with the new key, and bumps `key_version`
// — all inside one transaction, so a failure partway through (wrong
// current key, corrupted row, DB error) rolls back every row rather than
// leaving some rows on the old key and some on the new one.
//
// After this exits successfully: update KNOTRACK_ENCRYPTION_KEY to the
// new key value in your deploy environment and redeploy. Until you do
// that, the server is still decrypting with the *old* key while the
// database now holds credentials encrypted with the *new* one — don't
// restart the server in between.
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent } from '../src/config/load-dotenv.js';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { listAllAdapters, updateAdapterEncryptedCredential } from '../src/db/queries/adapters.js';
import { decryptCredential, encryptCredential } from '../src/crypto/credential-cipher.js';

export function parseNewKey(value: string | undefined): Buffer {
  if (!value) {
    throw new Error(
      'KNOTRACK_ENCRYPTION_KEY_NEW is required — generate one with: openssl rand -base64 32',
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    throw new Error('KNOTRACK_ENCRYPTION_KEY_NEW is not valid base64');
  }
  if (decoded.length !== 32) {
    throw new Error(
      `KNOTRACK_ENCRYPTION_KEY_NEW must decode to exactly 32 bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

export async function rotateEncryptionKey(
  pool: Parameters<typeof withTransaction>[0],
  currentKey: Buffer,
  newKey: Buffer,
): Promise<number> {
  if (currentKey.equals(newKey)) {
    throw new Error('KNOTRACK_ENCRYPTION_KEY_NEW must differ from the current key');
  }
  return withTransaction(pool, async (client) => {
    const rows = await listAllAdapters(client);
    for (const row of rows) {
      const plaintext = decryptCredential(row.encrypted_credential, currentKey);
      const reEncrypted = encryptCredential(plaintext, newKey);
      await updateAdapterEncryptedCredential(client, row.id, reEncrypted, row.key_version + 1);
    }
    return rows.length;
  });
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();
  const newKey = parseNewKey(process.env.KNOTRACK_ENCRYPTION_KEY_NEW);

  const pool = createPool(config);
  try {
    const rotatedCount = await rotateEncryptionKey(pool, config.encryptionKey, newKey);
    console.log(
      `rotated ${rotatedCount} adapter credential(s). ` +
        'Now set KNOTRACK_ENCRYPTION_KEY to the new key value and redeploy — ' +
        'do not restart the server with the old key still configured.',
    );
  } finally {
    await pool.end();
  }
}

// Only auto-run when executed directly (`npm run rotate-encryption-key`),
// not when imported by tests — same guard as scripts/migrate.ts.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error('rotate-encryption-key failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
