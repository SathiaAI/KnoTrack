import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rotateEncryptionKey } from '../../scripts/rotate-encryption-key.js';
import { upsertAdapter, listAllAdapters } from '../../src/db/queries/adapters.js';
import { decryptCredential, encryptCredential } from '../../src/crypto/credential-cipher.js';
import { upsertProjectBySourceRef } from '../../src/db/queries/projects.js';
import { closeTestPool, getTestPool, truncateAll } from './helpers.js';

const pool = getTestPool();
const OLD_KEY = Buffer.alloc(32, 1);
const NEW_KEY = Buffer.alloc(32, 2);

async function seedAdapter(sourceRef: string, plaintext: string) {
  const project = await upsertProjectBySourceRef(pool, {
    name: `Project ${sourceRef}`,
    sourceType: 'local',
    sourceRef,
  });
  await upsertAdapter(pool, {
    projectId: project.id,
    type: 'github',
    encryptedCredential: encryptCredential(plaintext, OLD_KEY),
    config: {},
  });
  return project.id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('rotate-encryption-key: rotateEncryptionKey', () => {
  it('positive: re-encrypts every adapter row with the new key and bumps key_version', async () => {
    await seedAdapter('/tmp/repo-a', 'secret-a');
    await seedAdapter('/tmp/repo-b', 'secret-b');

    const rotated = await rotateEncryptionKey(pool, OLD_KEY, NEW_KEY);
    expect(rotated).toBe(2);

    const rows = await listAllAdapters(pool);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.key_version).toBe(2);
      // Decrypts cleanly with the new key...
      const plaintext = decryptCredential(row.encrypted_credential, NEW_KEY);
      expect(['secret-a', 'secret-b']).toContain(plaintext);
      // ...and no longer with the old one.
      expect(() => decryptCredential(row.encrypted_credential, OLD_KEY)).toThrow();
    }
  });

  it('negative: rejects rotating to the same key', async () => {
    await seedAdapter('/tmp/repo-c', 'secret-c');
    await expect(rotateEncryptionKey(pool, OLD_KEY, OLD_KEY)).rejects.toThrow(
      /must differ from the current key/,
    );
    const rows = await listAllAdapters(pool);
    expect(rows[0]?.key_version).toBe(1);
  });

  it('negative: a wrong current key rolls back every row, not just the one that failed', async () => {
    await seedAdapter('/tmp/repo-d', 'secret-d');
    await seedAdapter('/tmp/repo-e', 'secret-e');
    const wrongKey = Buffer.alloc(32, 9);

    await expect(rotateEncryptionKey(pool, wrongKey, NEW_KEY)).rejects.toThrow();

    const rows = await listAllAdapters(pool);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Still on the original key/version — nothing partially rotated.
      expect(row.key_version).toBe(1);
      expect(() => decryptCredential(row.encrypted_credential, OLD_KEY)).not.toThrow();
    }
  });
});
