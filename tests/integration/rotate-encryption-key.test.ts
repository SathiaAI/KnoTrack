import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rotateEncryptionKey } from '../../scripts/rotate-encryption-key.js';
import { upsertAdapter, listAllAdapters } from '../../src/db/queries/adapters.js';
import { decryptCredential, encryptCredential } from '../../src/crypto/credential-cipher.js';
import { upsertProjectBySourceRef } from '../../src/db/queries/projects.js';
import { closeTestPool, getTestPool, truncateAll } from './helpers.js';

const pool = getTestPool();
const OLD_KEY = Buffer.alloc(32, 1);
const NEW_KEY = Buffer.alloc(32, 2);

async function seedAdapter(sourceRef: string, plaintext: string, key: Buffer = OLD_KEY) {
  const project = await upsertProjectBySourceRef(pool, {
    name: `Project ${sourceRef}`,
    sourceType: 'local',
    sourceRef,
  });
  await upsertAdapter(pool, {
    projectId: project.id,
    type: 'github',
    encryptedCredential: encryptCredential(plaintext, key),
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

  it('positive: a row inserted between two rotations ends up on the same key_version as rows rotated both times', async () => {
    // CodeRabbit finding on PR #4: upsertAdapter used to leave key_version
    // to the column's DEFAULT 1, so a row created after a rotation (when
    // every existing row was already bumped to a later generation) would
    // silently disagree with the rest of the table about which key
    // generation it's on — even though it's actually encrypted with the
    // same (current) key as everything else.
    await seedAdapter('/tmp/repo-f', 'secret-f');

    // Rotation 1: OLD_KEY -> NEW_KEY. Every existing row (just repo-f) goes
    // to key_version 2.
    await rotateEncryptionKey(pool, OLD_KEY, NEW_KEY);

    // A new adapter registered *after* rotation 1, encrypted with the now-
    // current key (NEW_KEY) — simulating kt_register_project running
    // against a server that's already been redeployed with the new key.
    await seedAdapter('/tmp/repo-g', 'secret-g', NEW_KEY);

    const afterFirstRegistration = await listAllAdapters(pool);
    expect(afterFirstRegistration).toHaveLength(2);
    // Both rows must agree on which generation they're on *before* the
    // next rotation touches either of them.
    const versions = new Set(afterFirstRegistration.map((r) => r.key_version));
    expect(versions.size).toBe(1);
    expect([...versions][0]).toBe(2);

    // Rotation 2: NEW_KEY -> a third key. Both rows are actually on
    // NEW_KEY at this point, so both must decrypt cleanly and both must
    // land on the *same* next key_version — not one row jumping to 3
    // while the other silently stays behind, or vice versa.
    const THIRD_KEY = Buffer.alloc(32, 3);
    const rotated = await rotateEncryptionKey(pool, NEW_KEY, THIRD_KEY);
    expect(rotated).toBe(2);

    const afterSecondRotation = await listAllAdapters(pool);
    expect(afterSecondRotation).toHaveLength(2);
    for (const row of afterSecondRotation) {
      expect(row.key_version).toBe(3);
      expect(decryptCredential(row.encrypted_credential, THIRD_KEY)).toMatch(/^secret-[fg]$/);
    }
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
