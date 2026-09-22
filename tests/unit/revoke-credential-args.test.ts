import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/revoke-credential.js';

describe('revoke-credential parseArgs (T5.4)', () => {
  it('parses <project_id> <type> with no confirmation by default', () => {
    expect(parseArgs(['p1', 'github'])).toEqual({
      projectId: 'p1',
      type: 'github',
      confirmed: false,
    });
  });

  it('accepts --yes in any position', () => {
    expect(parseArgs(['p1', 'linear', '--yes'])).toEqual({
      projectId: 'p1',
      type: 'linear',
      confirmed: true,
    });
    expect(parseArgs(['--yes', 'p1', 'github'])).toEqual({
      projectId: 'p1',
      type: 'github',
      confirmed: true,
    });
  });

  it('throws on a missing project id', () => {
    expect(() => parseArgs(['github'])).toThrow(/usage/);
    expect(() => parseArgs([])).toThrow(/usage/);
  });

  it('throws on a type outside the github|linear allowlist', () => {
    expect(() => parseArgs(['p1', 'svn'])).toThrow(/usage/);
    expect(() => parseArgs(['p1', 'local'])).toThrow(/usage/);
  });
});
