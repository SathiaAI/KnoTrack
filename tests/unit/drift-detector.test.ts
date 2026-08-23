import { describe, expect, it } from 'vitest';
import { findSequenceSkips } from '../../src/domain/drift-detector.js';
import type { ItemRow } from '../../src/db/queries/items.js';

function item(overrides: Partial<ItemRow>): ItemRow {
  return {
    id: overrides.id ?? 'item-id',
    track_id: 'track-id',
    title: overrides.title ?? 'Untitled',
    sequence_position: overrides.sequence_position ?? 1,
    status: overrides.status ?? 'pending',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('findSequenceSkips', () => {
  it('finds no skips when items complete in order', () => {
    const items = [
      item({ id: '1', sequence_position: 1, status: 'done' }),
      item({ id: '2', sequence_position: 2, status: 'pending' }),
    ];
    expect(findSequenceSkips(items)).toEqual([]);
  });

  it('flags a later item done while an earlier one is still pending', () => {
    const items = [
      item({ id: '1', sequence_position: 1, status: 'pending', title: 'Add refresh endpoint' }),
      item({ id: '2', sequence_position: 2, status: 'done', title: 'Add rotation tests' }),
    ];
    const findings = findSequenceSkips(items);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.itemId).toBe('2');
    expect(findings[0]?.detail).toContain('Add rotation tests');
    expect(findings[0]?.detail).toContain('Add refresh endpoint');
  });

  it('flags a later item done while an earlier one is blocked', () => {
    const items = [
      item({ id: '1', sequence_position: 1, status: 'blocked' }),
      item({ id: '2', sequence_position: 2, status: 'done' }),
    ];
    expect(findSequenceSkips(items)).toHaveLength(1);
  });

  it('does not flag when the earlier item is also done', () => {
    const items = [
      item({ id: '1', sequence_position: 1, status: 'done' }),
      item({ id: '2', sequence_position: 2, status: 'done' }),
    ];
    expect(findSequenceSkips(items)).toEqual([]);
  });
});
