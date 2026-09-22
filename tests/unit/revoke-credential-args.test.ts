import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/revoke-credential.js';

describe('revoke-credential parseArgs (T5.4)', () => {
  it('parses <project_id> <type> with no confirmation by default', () => {
    expect(parseArgs(['11111111-1111-1111-1111-111111111111', 'github'])).toEqual({
      projectId: '11111111-1111-1111-1111-111111111111',
      type: 'github',
      confirmed: false,
    });
  });

  it('accepts --yes in any position', () => {
    expect(parseArgs(['11111111-1111-1111-1111-111111111111', 'linear', '--yes'])).toEqual({
      projectId: '11111111-1111-1111-1111-111111111111',
      type: 'linear',
      confirmed: true,
    });
    expect(parseArgs(['--yes', '11111111-1111-1111-1111-111111111111', 'github'])).toEqual({
      projectId: '11111111-1111-1111-1111-111111111111',
      type: 'github',
      confirmed: true,
    });
  });

  it('throws on a missing project id', () => {
    expect(() => parseArgs(['github'])).toThrow(/usage/);
    expect(() => parseArgs([])).toThrow(/usage/);
  });

  it('throws on a type outside the github|linear allowlist', () => {
    expect(() => parseArgs(['11111111-1111-1111-1111-111111111111', 'svn'])).toThrow(/usage/);
    expect(() => parseArgs(['11111111-1111-1111-1111-111111111111', 'local'])).toThrow(/usage/);
  });

  it('throws on a non-UUID project id', () => {
    expect(() => parseArgs(['not-a-uuid', 'github'])).toThrow(/UUID/);
  });
});
