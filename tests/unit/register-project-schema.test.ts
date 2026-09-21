import { describe, expect, it } from 'vitest';
import { registerProjectInputSchema } from '../../src/schemas/tools.js';

function base(linear: Record<string, unknown>) {
  return {
    name: 'P',
    source_type: 'linear' as const,
    source_ref: 'team-1',
    adapters: { linear: { api_key: 'lin_key', team_id: 'team-1', ...linear } },
  };
}

describe('registerProjectInputSchema — Linear workflow-state overrides (T5.3)', () => {
  it('accepts omitted overrides', () => {
    expect(registerProjectInputSchema.safeParse(base({})).success).toBe(true);
  });

  it('accepts and trims a valid override', () => {
    const parsed = registerProjectInputSchema.safeParse(base({ done_state_id: '  s-done  ' }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.adapters?.linear?.done_state_id).toBe('s-done');
    }
  });

  it('rejects a whitespace-only done_state_id (not silently coerced to unset)', () => {
    expect(registerProjectInputSchema.safeParse(base({ done_state_id: '   ' })).success).toBe(
      false,
    );
  });

  it('rejects a whitespace-only open_state_id', () => {
    expect(registerProjectInputSchema.safeParse(base({ open_state_id: '\t' })).success).toBe(false);
  });
});
