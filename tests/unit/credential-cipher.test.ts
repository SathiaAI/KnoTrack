import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential } from '../../src/crypto/credential-cipher.js';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

describe('credential-cipher', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const packed = encryptCredential('ghp_super_secret', KEY);
    expect(decryptCredential(packed, KEY)).toBe('ghp_super_secret');
  });

  it('produces a different IV (and therefore different ciphertext) each call', () => {
    const a = encryptCredential('same plaintext', KEY);
    const b = encryptCredential('same plaintext', KEY);
    expect(a.equals(b)).toBe(false);
  });

  it('never contains the plaintext as a byte substring', () => {
    const packed = encryptCredential('findable-plaintext-marker', KEY);
    expect(packed.includes(Buffer.from('findable-plaintext-marker'))).toBe(false);
  });

  it('fails to decrypt with the wrong key', () => {
    const packed = encryptCredential('secret', KEY);
    expect(() => decryptCredential(packed, OTHER_KEY)).toThrow();
  });

  it('fails to decrypt tampered ciphertext (auth tag mismatch)', () => {
    const packed = encryptCredential('secret', KEY);
    const tampered = Buffer.from(packed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptCredential(tampered, KEY)).toThrow();
  });
});
