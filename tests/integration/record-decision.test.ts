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

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_record_decision', () => {
  it('positive: inserts a decision and returns its id', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    const result = await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Switch to Postgres',
      rationale: 'SQLite could not handle concurrent writers.',
      what_changed: 'Storage layer now targets Postgres 13+.',
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
    });
  });

  it("positive: sets the track's status to pivot_pending as a side effect (TRD §3.10)", async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    const before = await pool.query('SELECT status FROM tracks WHERE id = $1', [trackId]);
    expect(before.rows[0]?.status).toBe('on_track');

    await recordDecisionService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Pivot',
      rationale: 'Reasons.',
      what_changed: 'Things changed.',
    });

    const after = await pool.query('SELECT status FROM tracks WHERE id = $1', [trackId]);
    expect(after.rows[0]?.status).toBe('pivot_pending');
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
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
