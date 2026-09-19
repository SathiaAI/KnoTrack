import { describe, expect, it } from 'vitest';
import {
  buildIssuePayload,
  payloadContentHash,
  trackMarker,
  type ItemForIssue,
} from '../../src/mcp/tools/issue-payload.js';

const TRACK_ID = '11111111-1111-4111-8111-111111111111';

function items(...specs: Array<[string, string, number]>): ItemForIssue[] {
  return specs.map(([title, status, sequence_position]) => ({ title, status, sequence_position }));
}

describe('buildIssuePayload', () => {
  it('maps title, open state, checklist in sequence order, and embeds the hidden marker', () => {
    const payload = buildIssuePayload(
      { id: TRACK_ID, title: 'Auth overhaul', status: 'on_track' },
      items(['Rotation tests', 'pending', 2], ['Refresh endpoint', 'done', 1]),
    );
    expect(payload.title).toBe('Auth overhaul');
    expect(payload.state).toBe('open');
    expect(payload.state_reason).toBeUndefined();
    // sequence order, done -> [x], others -> [ ]
    const refreshIdx = payload.body.indexOf('- [x] Refresh endpoint');
    const rotationIdx = payload.body.indexOf('- [ ] Rotation tests');
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(rotationIdx).toBeGreaterThan(refreshIdx);
    expect(payload.body).toContain(trackMarker(TRACK_ID));
    expect(payload.body).toContain('`on_track`');
  });

  it('closes the issue only for a done track, with state_reason completed', () => {
    const done = buildIssuePayload({ id: TRACK_ID, title: 'T', status: 'done' }, []);
    expect(done.state).toBe('closed');
    expect(done.state_reason).toBe('completed');

    for (const status of ['on_track', 'pivot_pending', 'blocked']) {
      const open = buildIssuePayload({ id: TRACK_ID, title: 'T', status }, []);
      expect(open.state).toBe('open');
      expect(open.state_reason).toBeUndefined();
    }
  });

  it('renders a placeholder when the track has no items', () => {
    const payload = buildIssuePayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, []);
    expect(payload.body).toContain('_No items yet._');
  });

  it('truncates an over-long title to 256 chars', () => {
    const long = 'x'.repeat(500);
    const payload = buildIssuePayload({ id: TRACK_ID, title: long, status: 'on_track' }, []);
    expect(payload.title).toHaveLength(256);
  });

  it('truncates the body to GitHub’s 65,536-char cap but always keeps the recovery marker', () => {
    const many = items(
      ...Array.from(
        { length: 400 },
        (_, i) => ['y'.repeat(300), 'pending', i] as [string, string, number],
      ),
    );
    const payload = buildIssuePayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, many);
    expect(payload.body.length).toBeLessThanOrEqual(65_536);
    // Critical: an over-long body must NOT truncate away the marker, or crash
    // recovery could not find the issue and would duplicate it.
    expect(payload.body).toContain(trackMarker(TRACK_ID));
    expect(payload.body.endsWith(trackMarker(TRACK_ID))).toBe(true);
  });

  it('caps the rendered checklist and notes the elision', () => {
    const many = items(
      ...Array.from(
        { length: 350 },
        (_, i) => [`item ${i}`, 'pending', i] as [string, string, number],
      ),
    );
    const payload = buildIssuePayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, many);
    expect(payload.body).toMatch(/more item\(s\) not shown/);
  });
});

describe('payloadContentHash', () => {
  it('is stable for identical payloads and 64 hex chars', () => {
    const p = buildIssuePayload(
      { id: TRACK_ID, title: 'T', status: 'on_track' },
      items(['A', 'pending', 1]),
    );
    const h1 = payloadContentHash(p);
    const h2 = payloadContentHash(
      buildIssuePayload(
        { id: TRACK_ID, title: 'T', status: 'on_track' },
        items(['A', 'pending', 1]),
      ),
    );
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when an item status changes (so a real change re-syncs)', () => {
    const before = payloadContentHash(
      buildIssuePayload(
        { id: TRACK_ID, title: 'T', status: 'on_track' },
        items(['A', 'pending', 1]),
      ),
    );
    const after = payloadContentHash(
      buildIssuePayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, items(['A', 'done', 1])),
    );
    expect(before).not.toBe(after);
  });

  it('changes when the track open/closed state changes', () => {
    const open = payloadContentHash(
      buildIssuePayload({ id: TRACK_ID, title: 'T', status: 'on_track' }, []),
    );
    const closed = payloadContentHash(
      buildIssuePayload({ id: TRACK_ID, title: 'T', status: 'done' }, []),
    );
    expect(open).not.toBe(closed);
  });
});
