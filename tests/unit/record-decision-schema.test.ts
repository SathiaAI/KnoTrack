// recordDecisionInputSchema's superRefine cross-field rule (docs/TRD.md
// §3.10): expected_pivot_decision_id required iff effect is
// 'resolve_pivot'. No prior test covered this directly — added alongside
// the PR #16 Codex review fix that closed the "present for any other
// effect" half of the "if and only if" (previously only the "missing for
// resolve_pivot" half was enforced).
import { describe, expect, it } from 'vitest';
import { recordDecisionInputSchema } from '../../src/schemas/tools.js';

const base = {
  project_id: '11111111-1111-4111-8111-111111111111',
  track_id: '22222222-2222-4222-8222-222222222222',
  title: 'T',
  rationale: 'R',
  what_changed: 'C',
};
const someId = '33333333-3333-4333-8333-333333333333';

describe('recordDecisionInputSchema', () => {
  it('positive: "resolve_pivot" with expected_pivot_decision_id parses', () => {
    const result = recordDecisionInputSchema.safeParse({
      ...base,
      effect: 'resolve_pivot',
      expected_pivot_decision_id: someId,
    });
    expect(result.success).toBe(true);
  });

  it('positive: "note" and "open_pivot" parse without expected_pivot_decision_id', () => {
    expect(recordDecisionInputSchema.safeParse({ ...base, effect: 'note' }).success).toBe(true);
    expect(recordDecisionInputSchema.safeParse({ ...base, effect: 'open_pivot' }).success).toBe(
      true,
    );
  });

  it('negative: "resolve_pivot" without expected_pivot_decision_id is rejected', () => {
    const result = recordDecisionInputSchema.safeParse({ ...base, effect: 'resolve_pivot' });
    expect(result.success).toBe(false);
  });

  it('negative (PR #16 Codex review): expected_pivot_decision_id supplied with "note" or "open_pivot" is rejected, not silently ignored', () => {
    const withNote = recordDecisionInputSchema.safeParse({
      ...base,
      effect: 'note',
      expected_pivot_decision_id: someId,
    });
    const withOpenPivot = recordDecisionInputSchema.safeParse({
      ...base,
      effect: 'open_pivot',
      expected_pivot_decision_id: someId,
    });
    expect(withNote.success).toBe(false);
    expect(withOpenPivot.success).toBe(false);
  });
});
