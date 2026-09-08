import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordDecisionService } from '../../src/mcp/tools/record-decision.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeProjectAndTrack(): Promise<{ projectId: string; trackId: string }> {
  const { project_id } = await registerProjectService(pool, config, {
    name: 'P',
    source_type: 'local',
    source_ref: `/tmp/${crypto.randomUUID()}`,
    adapters: undefined,
  });
  const { track_id } = await createTrackService(pool, config, {
    project_id,
    title: 'T',
    depends_on: [],
    source_doc_ref: undefined,
  });
  return { projectId: project_id, trackId: track_id };
}

async function trackStatus(trackId: string): Promise<string> {
  const row = await pool.query<{ status: string }>(
    'SELECT status FROM track_readiness WHERE id = $1',
    [trackId],
  );
  const status = row.rows[0]?.status;
  if (status === undefined) throw new Error(`trackStatus: no track_readiness row for ${trackId}`);
  return status;
}

async function pivotDecisionId(trackId: string): Promise<string | null> {
  const row = await pool.query<{ pivot_decision_id: string | null }>(
    'SELECT pivot_decision_id FROM tracks WHERE id = $1',
    [trackId],
  );
  return row.rows[0]?.pivot_decision_id ?? null;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_record_decision', () => {
  it('positive: default effect ("note") inserts a decision and returns its id', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    const result = await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Switch to Postgres',
      rationale: 'SQLite could not handle concurrent writers.',
      what_changed: 'Storage layer now targets Postgres 13+.',
      effect: 'note',
    });

    expect(result.decision_id).toEqual(expect.any(String));
    const row = await pool.query('SELECT * FROM decisions WHERE id = $1', [result.decision_id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      project_id: projectId,
      track_id: trackId,
      title: 'Switch to Postgres',
      rationale: 'SQLite could not handle concurrent writers.',
      what_changed: 'Storage layer now targets Postgres 13+.',
      effect: 'note',
      resolves_decision_id: null,
    });
  });

  it('positive (T2.16): a plain "note" decision has no side effect on the track\'s pivot state', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    const before = await trackStatus(trackId);
    expect(before).toBe('on_track');

    await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Just a note',
      rationale: 'Reasons.',
      what_changed: 'Things changed.',
      effect: 'note',
    });

    const after = await trackStatus(trackId);
    expect(after).toBe('on_track');
    expect(await pivotDecisionId(trackId)).toBeNull();
  });

  it('positive (T2.16): effect "open_pivot" sets the track to pivot_pending and records the pointer', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    const result = await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Pivot',
      rationale: 'Reasons.',
      what_changed: 'Things changed.',
      effect: 'open_pivot',
    });

    expect(await trackStatus(trackId)).toBe('pivot_pending');
    expect(await pivotDecisionId(trackId)).toBe(result.decision_id);
  });

  it('negative (T2.16): opening a pivot on an already-pivoted track is a 409', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'First pivot',
      rationale: 'R',
      what_changed: 'C',
      effect: 'open_pivot',
    });

    await expect(
      recordDecisionService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        title: 'Second pivot',
        rationale: 'R',
        what_changed: 'C',
        effect: 'open_pivot',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('positive (T2.16): effect "resolve_pivot" with the correct expected id clears the pivot', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const opened = await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Pivot',
      rationale: 'R',
      what_changed: 'C',
      effect: 'open_pivot',
    });

    await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Resolved',
      rationale: 'R2',
      what_changed: 'C2',
      effect: 'resolve_pivot',
      expected_pivot_decision_id: opened.decision_id,
    });

    expect(await trackStatus(trackId)).toBe('on_track');
    expect(await pivotDecisionId(trackId)).toBeNull();
    const resolveRow = await pool.query(
      `SELECT resolves_decision_id, effect FROM decisions WHERE track_id = $1 AND effect = 'resolve_pivot'`,
      [trackId],
    );
    expect(resolveRow.rows[0]).toMatchObject({
      resolves_decision_id: opened.decision_id,
      effect: 'resolve_pivot',
    });
  });

  it('negative (T2.16): resolving a track with no active pivot is a hard error, not a silent no-op', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    await expect(
      recordDecisionService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        title: 'Resolve nothing',
        rationale: 'R',
        what_changed: 'C',
        effect: 'resolve_pivot',
        expected_pivot_decision_id: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('no active pivot'),
    });
  });

  it('negative (T2.16): resolving with a stale expected_pivot_decision_id conflicts rather than overwriting', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const opened = await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Pivot',
      rationale: 'R',
      what_changed: 'C',
      effect: 'open_pivot',
    });

    await expect(
      recordDecisionService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        title: 'Wrong resolve',
        rationale: 'R',
        what_changed: 'C',
        effect: 'resolve_pivot',
        expected_pivot_decision_id: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The real pivot is untouched.
    expect(await trackStatus(trackId)).toBe('pivot_pending');
    expect(await pivotDecisionId(trackId)).toBe(opened.decision_id);
  });

  it('negative: 404 when project does not exist', async () => {
    const { trackId } = await makeProjectAndTrack();
    await expect(
      recordDecisionService(pool, config, {
        project_id: UNKNOWN_UUID,
        track_id: trackId,
        title: 'X',
        rationale: 'X',
        what_changed: 'X',
        effect: 'note',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when track does not exist in this project', async () => {
    const { projectId } = await makeProjectAndTrack();
    await expect(
      recordDecisionService(pool, config, {
        project_id: projectId,
        track_id: UNKNOWN_UUID,
        title: 'X',
        rationale: 'X',
        what_changed: 'X',
        effect: 'note',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when track_id belongs to a different project than project_id', async () => {
    // One flat API-token pool, no per-project scoping (src/server/auth.ts,
    // TRD §4) — mirrors get-track.test.ts's GTRK-08/09 cross-project case.
    const other = await makeProjectAndTrack();
    const { projectId } = await makeProjectAndTrack();

    await expect(
      recordDecisionService(pool, config, {
        project_id: projectId,
        track_id: other.trackId,
        title: 'X',
        rationale: 'X',
        what_changed: 'X',
        effect: 'note',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
