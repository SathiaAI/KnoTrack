import { describe, expect, it } from 'vitest';
import { hasCycle, wouldCreateCycle, topoSort } from '../../src/domain/dependency-graph.js';

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

describe('topoSort', () => {
  it('returns an empty array for an empty node set', () => {
    expect(topoSort([], [])).toEqual([]);
  });

  it('returns nodes with no edges in their input order', () => {
    expect(topoSort(['B', 'A'], [])).toEqual(['B', 'A']);
  });

  it('orders a simple chain prerequisite-first (A depends on B depends on C)', () => {
    // A -> B -> C means "A depends on B, B depends on C"; C has no
    // prerequisites so it must render first, A depends transitively on
    // both so it must render last.
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ];
    expect(topoSort(['A', 'B', 'C'], edges)).toEqual(['C', 'B', 'A']);
  });

  it('orders a diamond so both mid-tier nodes follow the shared prerequisite, ties broken by input order', () => {
    // A depends on B and C; both B and C depend on D.
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'D' },
    ];
    expect(topoSort(['A', 'B', 'C', 'D'], edges)).toEqual(['D', 'B', 'C', 'A']);
  });

  it('breaks ties among simultaneously-eligible nodes using the input array order', () => {
    // Three independent nodes, no edges at all: every node is eligible
    // from the start, so the result should exactly match input order.
    expect(topoSort(['Z', 'Y', 'X'], [])).toEqual(['Z', 'Y', 'X']);
  });

  it('falls back to appending leftover nodes in input order when a cycle is present', () => {
    // A <-> B is a cycle; C is independent and has no prerequisites, so
    // it's still emitted normally before the cycle-fallback kicks in.
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ];
    expect(topoSort(['A', 'B', 'C'], edges)).toEqual(['C', 'A', 'B']);
  });

  it('ignores edges referencing a node outside the given node set', () => {
    const edges = [{ from: 'A', to: 'GHOST' }];
    expect(topoSort(['A'], edges)).toEqual(['A']);
  });
});
