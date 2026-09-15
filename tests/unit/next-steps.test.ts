import { describe, expect, it } from 'vitest';
import { rankNextSteps, type NextStepsItemInput } from '../../src/domain/next-steps.js';

function item(
  overrides: Partial<NextStepsItemInput> & Pick<NextStepsItemInput, 'id' | 'track_id'>,
): NextStepsItemInput {
  return {
    title: 'Untitled',
    sequence_position: 1,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    dependsOnItemIds: [],
    ...overrides,
  };
}

describe('rankNextSteps', () => {
  it('recommends an item with no dependencies using the no-dependencies reason template', () => {
    const tracksById = new Map([
      ['t1', { title: 'Auth overhaul', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const result = rankNextSteps(
      [item({ id: 'i1', track_id: 't1', title: 'Add refresh endpoint' })],
      tracksById,
      new Map(),
      5,
    );

    expect(result).toEqual([
      {
        item_id: 'i1',
        title: 'Add refresh endpoint',
        track_id: 't1',
        track_title: 'Auth overhaul',
        reason: 'No dependencies — ready to start in track "Auth overhaul".',
      },
    ]);
  });

  it('recommends an item whose single dependency is done, using the has-dependencies reason template', () => {
    const tracksById = new Map([
      ['t1', { title: 'Auth overhaul', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const itemStatusById = new Map([['i1', 'done']]);
    const result = rankNextSteps(
      [item({ id: 'i2', track_id: 't1', title: 'Add rotation tests', dependsOnItemIds: ['i1'] })],
      tracksById,
      itemStatusById,
      5,
    );

    expect(result).toEqual([
      {
        item_id: 'i2',
        title: 'Add rotation tests',
        track_id: 't1',
        track_title: 'Auth overhaul',
        reason: 'All 1 dependency complete — next up in track "Auth overhaul".',
      },
    ]);
  });

  it('excludes an item with an unmet dependency', () => {
    const tracksById = new Map([
      ['t1', { title: 'T', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const itemStatusById = new Map([['i1', 'pending']]);
    const result = rankNextSteps(
      [item({ id: 'i2', track_id: 't1', dependsOnItemIds: ['i1'] })],
      tracksById,
      itemStatusById,
      5,
    );
    expect(result).toEqual([]);
  });

  it('excludes every item whose track has an unfinished dependency, even if individually ready (T2.16: keyed off dependenciesEffectivelyDone, not status)', () => {
    const tracksById = new Map([
      ['t1', { title: 'T', status: 'blocked', dependenciesEffectivelyDone: false }],
    ]);
    const result = rankNextSteps([item({ id: 'i1', track_id: 't1' })], tracksById, new Map(), 5);
    expect(result).toEqual([]);
  });

  it('T2.16: excludes every item whose track LOOKS on_track but has a two-hop dependency drift (dependenciesEffectivelyDone false despite status on_track)', () => {
    // Regression test for the exact bug class this whole redesign exists
    // to prevent: a track's own `status` can read `on_track` while one of
    // its dependencies is only locally OK, not effective_done (a broken
    // foundation two-plus hops away). get_next_steps must catch this via
    // dependenciesEffectivelyDone even though `status` alone wouldn't.
    const tracksById = new Map([
      ['t1', { title: 'Drifted track', status: 'on_track', dependenciesEffectivelyDone: false }],
    ]);
    const result = rankNextSteps([item({ id: 'i1', track_id: 't1' })], tracksById, new Map(), 5);
    expect(result).toEqual([]);
  });

  it('orders on_track before pivot_pending', () => {
    const tracksById = new Map([
      [
        'pivot',
        { title: 'Pivot track', status: 'pivot_pending', dependenciesEffectivelyDone: true },
      ],
      ['on', { title: 'On track', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const result = rankNextSteps(
      [
        item({ id: 'from-pivot', track_id: 'pivot', sequence_position: 1 }),
        item({ id: 'from-on', track_id: 'on', sequence_position: 1 }),
      ],
      tracksById,
      new Map(),
      5,
    );
    expect(result.map((r) => r.item_id)).toEqual(['from-on', 'from-pivot']);
  });

  it('orders by sequence_position ascending within the same track priority', () => {
    const tracksById = new Map([
      ['t1', { title: 'T', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const result = rankNextSteps(
      [
        item({ id: 'second', track_id: 't1', sequence_position: 2 }),
        item({ id: 'first', track_id: 't1', sequence_position: 1 }),
      ],
      tracksById,
      new Map(),
      5,
    );
    expect(result.map((r) => r.item_id)).toEqual(['first', 'second']);
  });

  it('orders by created_at ascending as the final tie-break', () => {
    const tracksById = new Map([
      ['t1', { title: 'T', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const result = rankNextSteps(
      [
        item({
          id: 'later',
          track_id: 't1',
          sequence_position: 1,
          created_at: new Date('2026-02-01T00:00:00.000Z'),
        }),
        item({
          id: 'earlier',
          track_id: 't1',
          sequence_position: 1,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ],
      tracksById,
      new Map(),
      5,
    );
    expect(result.map((r) => r.item_id)).toEqual(['earlier', 'later']);
  });

  it('breaks a full tie (same track priority, sequence_position, and created_at) by item id', () => {
    const tracksById = new Map([
      ['t1', { title: 'T', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const sameTimestamp = new Date('2026-01-01T00:00:00.000Z');
    const result = rankNextSteps(
      [
        item({ id: 'b', track_id: 't1', sequence_position: 1, created_at: sameTimestamp }),
        item({ id: 'a', track_id: 't1', sequence_position: 1, created_at: sameTimestamp }),
      ],
      tracksById,
      new Map(),
      5,
    );
    expect(result.map((r) => r.item_id)).toEqual(['a', 'b']);
  });

  it('caps the result at the given limit', () => {
    const tracksById = new Map([
      ['t1', { title: 'T', status: 'on_track', dependenciesEffectivelyDone: true }],
    ]);
    const items = [1, 2, 3, 4, 5, 6].map((n) =>
      item({ id: `i${n}`, track_id: 't1', sequence_position: n }),
    );
    const result = rankNextSteps(items, tracksById, new Map(), 3);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.item_id)).toEqual(['i1', 'i2', 'i3']);
  });
});
