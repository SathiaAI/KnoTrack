import { describe, expect, it } from 'vitest';
import {
  buildLinearPayload,
  linearPayloadContentHash,
  resolveLinearStateId,
  stateIntentFor,
  type ItemForLinear,
} from '../../src/mcp/tools/linear-payload.js';
import type { LinearWorkflowState } from '../../src/linear/linear-client.js';

const TRACK_ID = '11111111-1111-1111-1111-111111111111';

function items(...specs: Array<[string, string, number]>): ItemForLinear[] {
  return specs.map(([title, status, sequence_position], i) => ({
    id: `item-${i}`,
    title,
    status,
    sequence_position,
  }));
}

describe('buildLinearPayload', () => {
  it('maps title + a checklist in sequence order and embeds the hidden marker', () => {
    const payload = buildLinearPayload(
      { id: TRACK_ID, title: 'Auth overhaul', status: 'on_track' },
      items(['B second', 'pending', 2], ['A first', 'done', 1]),
    );
    expect(payload.title).toBe('Auth overhaul');
    expect(payload.description).toContain('- [x] A first');
    expect(payload.description).toContain('- [ ] B second');
    // ordered by sequence_position: A (1) before B (2)
    expect(payload.description.indexOf('A first')).toBeLessThan(
      payload.description.indexOf('B second'),
    );
    expect(payload.description).toContain(`<!-- knotrack:track:${TRACK_ID} -->`);
  });

  it('renders a placeholder when the track has no items', () => {
    const payload = buildLinearPayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, []);
    expect(payload.description).toContain('_No items yet._');
  });

  it('keeps the title within 255 chars even when escaping delimiters expands it', () => {
    const dense = '<!---->'.repeat(80);
    const payload = buildLinearPayload({ id: TRACK_ID, title: dense, status: 'on_track' }, []);
    expect(payload.title.length).toBeLessThanOrEqual(255);
    expect(payload.title).not.toContain('<!--');
  });

  it('neutralizes a fake recovery marker embedded in an item title', () => {
    const fake = `<!-- knotrack:track:${'2'.repeat(36)} -->`;
    const payload = buildLinearPayload(
      { id: TRACK_ID, title: 'T', status: 'on_track' },
      items([`sneaky ${fake}`, 'pending', 1]),
    );
    // the only real marker is KnoTrack's own; the injected one is escaped
    const real = `<!-- knotrack:track:${TRACK_ID} -->`;
    expect(payload.description.split('<!-- knotrack:track:').length - 1).toBe(1);
    expect(payload.description).toContain(real);
  });
});

describe('linearPayloadContentHash', () => {
  it('is stable for the same payload + intent', () => {
    const p = buildLinearPayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, []);
    expect(linearPayloadContentHash(p, 'open')).toBe(linearPayloadContentHash(p, 'open'));
  });

  it('changes when the state intent flips (so a done/undone flip re-syncs)', () => {
    const p = buildLinearPayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, []);
    expect(linearPayloadContentHash(p, 'open')).not.toBe(linearPayloadContentHash(p, 'done'));
  });

  it('changes when a configured state override changes (so re-config re-syncs)', () => {
    const p = buildLinearPayload({ id: TRACK_ID, title: 'T', status: 'done' }, []);
    const a = linearPayloadContentHash(p, 'done', { doneStateId: 's-done' });
    const b = linearPayloadContentHash(p, 'done', { doneStateId: 's-released' });
    expect(a).not.toBe(b);
    // and stable for the same override
    expect(a).toBe(linearPayloadContentHash(p, 'done', { doneStateId: 's-done' }));
  });
});

describe('stateIntentFor', () => {
  it('is done only for a done track', () => {
    expect(stateIntentFor('done')).toBe('done');
    for (const s of ['on_track', 'pivot_pending', 'blocked']) {
      expect(stateIntentFor(s)).toBe('open');
    }
  });
});

// ---- state resolver ----------------------------------------------------
function state(id: string, type: string, position: number): LinearWorkflowState {
  return { id, name: id, type, position };
}
const STATES: LinearWorkflowState[] = [
  state('s-backlog', 'backlog', 0),
  state('s-todo', 'unstarted', 1),
  state('s-doing', 'started', 2),
  state('s-done', 'completed', 3),
  state('s-released', 'completed', 5),
  state('s-cancelled', 'canceled', 6),
];

describe('resolveLinearStateId — done track', () => {
  it('auto-picks the lowest-position completed state', () => {
    const r = resolveLinearStateId({ states: STATES, trackStatus: 'done', mode: 'create' });
    expect(r).toEqual({ stateId: 's-done' });
  });

  it('uses a valid done_state_id override', () => {
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'done',
      mode: 'update',
      doneStateId: 's-released',
    });
    expect(r).toEqual({ stateId: 's-released' });
  });

  it('errors when done_state_id is not a completed-type state', () => {
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'done',
      mode: 'create',
      doneStateId: 's-doing',
    });
    expect(r).toHaveProperty('error');
    expect(String((r as { error: string }).error)).toMatch(/LINEAR_STATE_CONFIG/);
  });

  it('errors when done_state_id is unknown to the team', () => {
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'done',
      mode: 'create',
      doneStateId: 'nope',
    });
    expect(r).toHaveProperty('error');
  });

  it('errors when the team has no completed state and none is configured', () => {
    const noCompleted = STATES.filter((s) => s.type !== 'completed');
    const r = resolveLinearStateId({ states: noCompleted, trackStatus: 'done', mode: 'create' });
    expect(r).toHaveProperty('error');
    expect(String((r as { error: string }).error)).toMatch(/no 'completed' workflow state/);
  });

  it('breaks a position tie deterministically by id', () => {
    const tied = [state('b-done', 'completed', 3), state('a-done', 'completed', 3)];
    const r = resolveLinearStateId({ states: tied, trackStatus: 'done', mode: 'create' });
    expect(r).toEqual({ stateId: 'a-done' });
  });
});

describe('resolveLinearStateId — non-done track (never auto-moves)', () => {
  it('sets no state on create with no override (Linear default)', () => {
    expect(
      resolveLinearStateId({ states: STATES, trackStatus: 'on_track', mode: 'create' }),
    ).toEqual({});
  });

  it('sets no state on update with no override', () => {
    expect(
      resolveLinearStateId({ states: STATES, trackStatus: 'on_track', mode: 'update' }),
    ).toEqual({});
  });

  it('places a new issue in the configured open_state_id on create', () => {
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'on_track',
      mode: 'create',
      openStateId: 's-todo',
    });
    expect(r).toEqual({ stateId: 's-todo' });
  });

  it('reopens (moves backward) only when the issue is currently completed', () => {
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'on_track',
      mode: 'update',
      openStateId: 's-todo',
      currentStateType: 'completed',
    });
    expect(r).toEqual({ stateId: 's-todo' });
  });

  it('does NOT yank a started issue backward on update', () => {
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'on_track',
      mode: 'update',
      openStateId: 's-todo',
      currentStateType: 'started',
    });
    expect(r).toEqual({});
  });

  it('errors when open_state_id is a canceled-type state', () => {
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'on_track',
      mode: 'create',
      openStateId: 's-cancelled',
    });
    expect(r).toHaveProperty('error');
    expect(String((r as { error: string }).error)).toMatch(/canceled/);
  });

  it('errors when open_state_id is a completed-type state (terminal, Codex PR #25)', () => {
    // A completed state is terminal: placing a non-done issue there (or reopening
    // into it) is a misconfiguration and must surface LINEAR_STATE_CONFIG, not {ok}.
    const r = resolveLinearStateId({
      states: STATES,
      trackStatus: 'on_track',
      mode: 'create',
      openStateId: 's-done',
    });
    expect(r).toHaveProperty('error');
    expect(String((r as { error: string }).error)).toMatch(/LINEAR_STATE_CONFIG/);
    expect(String((r as { error: string }).error)).toMatch(/terminal/);
  });
});
