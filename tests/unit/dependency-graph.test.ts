import { describe, expect, it } from 'vitest';
import { hasCycle, wouldCreateCycle } from '../../src/domain/dependency-graph.js';

describe('hasCycle', () => {
  it('returns false for an empty graph', () => {
    expect(hasCycle([])).toBe(false);
  });

  it('returns false for a plain DAG', () => {
    // A -> B -> C, A -> C
    expect(
      hasCycle([
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'A', to: 'C' },
      ]),
    ).toBe(false);
  });

  it('detects a direct two-node cycle', () => {
    expect(
      hasCycle([
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ]),
    ).toBe(true);
  });

  it('detects a longer multi-hop cycle', () => {
    expect(
      hasCycle([
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'D' },
        { from: 'D', to: 'A' },
      ]),
    ).toBe(true);
  });
});

describe('wouldCreateCycle', () => {
  it('returns false when the new node only points at existing, older nodes (the normal case)', () => {
    // Existing DAG: B -> C
    const existing = [{ from: 'B', to: 'C' }];
    // New node A depends on B — cannot create a cycle since nothing
    // points at A yet (TRD §3.6's "no operation can point back at a
    // freshly created node" observation).
    expect(wouldCreateCycle(existing, 'A', ['B'])).toBe(false);
  });

  it('de-duplicates repeated ids in depends_on rather than erroring', () => {
    const existing: never[] = [];
    expect(wouldCreateCycle(existing, 'A', ['B', 'B', 'B'])).toBe(false);
  });

  it('flags a pre-existing cycle in the stored graph as a systemic invariant violation', () => {
    // Simulates data that predates the invariant (or was written by a
    // hypothetical future tool) — see TRD §3.6's rationale for why the
    // check runs unconditionally rather than only when it's reachable
    // through today's tool set.
    const existingCyclic = [
      { from: 'X', to: 'Y' },
      { from: 'Y', to: 'X' },
    ];
    expect(wouldCreateCycle(existingCyclic, 'NEW', [])).toBe(true);
  });
});
