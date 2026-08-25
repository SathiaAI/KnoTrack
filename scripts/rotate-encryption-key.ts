#!/usr/bin/env tsx
// Rotates KNOTRACK_ENCRYPTION_KEY across every stored adapter credential
// (docs/TRD.md §5 "Known gap" / docs/ROADMAP.md's encryption-key-rotation
// T9.x item). Manual, operator-run, offline-key-swap rotation — KnoTrack
// v1 never supports more than one *active* encryption key on a running
// server; this script is what an operator runs once, between shutting the
// server down (or otherwise pausing writes to `adapters`) and redeploying
// it with the new key.
//
// Usage (local dev, via tsx):
//   export KNOTRACK_ENCRYPTION_KEY_NEW=$(openssl rand -base64 32)
//   echo "New key — you'll need this for KNOTRACK_ENCRYPTION_KEY: $KNOTRACK_ENCRYPTION_KEY_NEW"
//   npm run rotate-encryption-key
//
// Usage (Docker / production runtime image): the image's runtime stage
// has no `tsx` (a devDependency, stripped by `npm ci --omit=dev`) and
// only copies `dist`, not `scripts/*.ts` — same constraint
// scripts/migrate.ts already documents in the Dockerfile. Run the
// compiled output directly instead, same pattern as migrations:
//   docker run --rm --env-file .env -e KNOTRACK_ENCRYPTION_KEY_NEW=<value> \
//     <image> node dist/scripts/rotate-encryption-key.js
//
// Generate and save the new key value *before* running either form —
// `export`, not a same-line `VAR=value command` prefix, so it survives
// in your shell after the command exits, and echo it so you can copy it
// somewhere durable. The script itself also prints it back on success
// (see main(), below) as a second line of defense: if the value is lost
// after rotation completes, every stored adapter credential becomes
// permanently undecryptable — there is no way to recover it.
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
  // Kept as the original base64 string (not just the decoded Buffer) so
  // it can be echoed back verbatim below — the exact value the operator
  // must paste into KNOTRACK_ENCRYPTION_KEY, not a re-derived encoding of
  // it that could subtly differ.
  const newKeyRaw = process.env.KNOTRACK_ENCRYPTION_KEY_NEW;
  const newKey = parseNewKey(newKeyRaw);

  const pool = createPool(config);
  try {
    const rotatedCount = await rotateEncryptionKey(pool, config.encryptionKey, newKey);
    // Codex finding on PR #4 (P1): the documented one-line usage
    // (`KNOTRACK_ENCRYPTION_KEY_NEW=$(openssl rand -base64 32) npm run
    // rotate-encryption-key`) scopes the generated value to the npm
    // child process only — it never lands in the operator's shell and
    // this script never echoed it, so following that exact usage lost
    // the new key forever the moment this process exited, making every
    // just-rotated credential permanently undecryptable. Printing it
    // back here is the same "print secrets to stdout only, never persist
    // them" convention scripts/generate-token.ts already uses — a second
    // line of defense regardless of how the caller obtained the value.
    console.log(
      `rotated ${rotatedCount} adapter credential(s).\n` +
        `New key (save this now — it cannot be recovered otherwise): ${newKeyRaw}\n` +
        'Set KNOTRACK_ENCRYPTION_KEY to the value above and redeploy — ' +
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
