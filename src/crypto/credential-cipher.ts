// AES-256-GCM encrypt/decrypt for adapter credentials (TRD §5).
//
// Schema note: TRD §5's Appendix A describes a dedicated
// `adapter_credentials` table with separate `ciphertext`/`iv`/`auth_tag`
// columns. The authoritative, already-applied migration
// (migrations/001_init.sql, documented in docs/DATABASE_SCHEMA.md) instead
// has a single `adapters.encrypted_credential bytea` column with no
// sibling iv/auth_tag columns. Resolution: pack `iv (12 bytes) ||
// authTag (16 bytes) || ciphertext` into that one column. This preserves
// every guarantee TRD §5 cares about (fresh random IV per secret, key
// never touches Postgres, generic 500 on tamper/wrong-key) while fitting
// the real, already-migrated schema instead of one this scaffold is not
// authorized to alter.
import crypto from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

export function encryptCredential(plaintext: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptCredential(packed: Buffer, key: Buffer): string {
  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('encrypted_credential blob is too short to contain iv+authTag');
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  // authTagLength is passed explicitly (not left to default) so setAuthTag
  // enforces exactly 16 bytes rather than accepting a truncated tag —
  // this is the fix for javascript.node-crypto.security.gcm-no-tag-length.
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
