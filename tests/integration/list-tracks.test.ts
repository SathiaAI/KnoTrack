import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listTracksService } from '../../src/mcp/tools/list-tracks.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeProject(): Promise<string> {
  const { project_id } = await registerProjectService(pool, config, {
    name: 'P',
    source_type: 'local',
    source_ref: `/tmp/${crypto.randomUUID()}`,
    adapters: undefined,
  });
  return project_id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_list_tracks', () => {
  it('positive: no status filter returns all tracks for the project (LTRK-01)', async () => {
    const projectId = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: 'docs/a.md',
    });
    const b = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [a.track_id],
      source_doc_ref: undefined,
    });

    const result = await listTracksService(pool, config, {
      project_id: projectId,
      status: undefined,
    });

    expect(result.tracks).toHaveLength(2);
    const byId = new Map(result.tracks.map((t) => [t.track_id, t]));
    expect(byId.get(a.track_id)).toMatchObject({
      title: 'A',
      status: 'on_track',
      source_doc_ref: 'docs/a.md',
      depends_on_track_ids: [],
      item_counts: { pending: 0, in_progress: 0, done: 0, blocked: 0 },
    });
    expect(byId.get(b.track_id)).toMatchObject({
      title: 'B',
      status: 'blocked',
      source_doc_ref: null,
      depends_on_track_ids: [a.track_id],
    });
  });

  it('positive: status filter returns only matching tracks (LTRK-02)', async () => {
    const projectId = await makeProject();
    const onTrack = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'On track',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Also on track',
      depends_on: [],
      source_doc_ref: undefined,
    });

    const result = await listTracksService(pool, config, {
      project_id: projectId,
      status: 'on_track',
    });

    expect(result.tracks).toHaveLength(2);
    expect(result.tracks.every((t) => t.status === 'on_track')).toBe(true);
    expect(result.tracks.map((t) => t.track_id)).toContain(onTrack.track_id);
  });

  it('positive: status filter matching zero tracks returns an empty list (LTRK-03)', async () => {
    const projectId = await makeProject();
    await createTrackService(pool, config, {
      project_id: projectId,
      title: 'On track',
      depends_on: [],
      source_doc_ref: undefined,
    });

    const result = await listTracksService(pool, config, {
      project_id: projectId,
      status: 'done',
    });

    expect(result.tracks).toEqual([]);
  });

  it('negative: 404 when project does not exist (LTRK-07)', async () => {
    await expect(
      listTracksService(pool, config, { project_id: UNKNOWN_UUID, status: undefined }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("positive: item_counts reflect each track's own items only (LTRK-09)", async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await pool.query(
      `INSERT INTO items (track_id, title, sequence_position, status) VALUES
         ($1, 'i1', 1, 'pending'), ($1, 'i2', 2, 'done')`,
      [track.track_id],
    );

    const result = await listTracksService(pool, config, {
      project_id: projectId,
      status: undefined,
    });

    expect(result.tracks[0]?.item_counts).toEqual({
      pending: 1,
      in_progress: 0,
      done: 1,
      blocked: 0,
    });
  });
});
