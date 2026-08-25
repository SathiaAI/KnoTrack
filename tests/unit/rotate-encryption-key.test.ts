import { describe, expect, it } from 'vitest';
import { parseNewKey } from '../../scripts/rotate-encryption-key.js';

describe('rotate-encryption-key: parseNewKey', () => {
  it('positive: decodes a valid 32-byte base64 key', () => {
    const key = Buffer.alloc(32, 5).toString('base64');
    const decoded = parseNewKey(key);
    expect(decoded).toEqual(Buffer.alloc(32, 5));
  });

  it('negative: throws when KNOTRACK_ENCRYPTION_KEY_NEW is unset', () => {
    expect(() => parseNewKey(undefined)).toThrow(/KNOTRACK_ENCRYPTION_KEY_NEW is required/);
  });

  it('negative: throws when the decoded key is the wrong length', () => {
    const tooShort = Buffer.alloc(16, 1).toString('base64');
    expect(() => parseNewKey(tooShort)).toThrow(/exactly 32 bytes/);
  });
});
