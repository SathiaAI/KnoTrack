import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTrackService } from '../../src/mcp/tools/get-track.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
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
    title: 'Auth overhaul',
    depends_on: [],
    source_doc_ref: 'docs/auth-spec.md',
  });
  return { projectId: project_id, trackId: track_id };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_get_track', () => {
  it('positive: returns track, items, and dependency_graph consistent with the DB (GTRK-01)', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const first = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add refresh endpoint',
      sequence_position: undefined,
      depends_on: [],
    });
    const second = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add rotation tests',
      sequence_position: undefined,
      depends_on: [first.item_id],
    });

    const result = await getTrackService(pool, config, {
      project_id: projectId,
      track_id: trackId,
    });

    expect(result.track).toMatchObject({
      track_id: trackId,
      title: 'Auth overhaul',
      status: 'on_track',
      source_doc_ref: 'docs/auth-spec.md',
      depends_on_track_ids: [],
    });
    expect(result.items).toEqual([
      {
        item_id: first.item_id,
        title: 'Add refresh endpoint',
        status: 'pending',
        sequence_position: 1,
        depends_on_item_ids: [],
      },
      {
        item_id: second.item_id,
        title: 'Add rotation tests',
        status: 'pending',
        sequence_position: 2,
        depends_on_item_ids: [first.item_id],
      },
    ]);
    expect(result.dependency_graph.nodes).toHaveLength(2);
    expect(result.dependency_graph.edges).toEqual([
      { item_id: second.item_id, depends_on_item_id: first.item_id },
    ]);
  });

  it('positive: zero items -> items=[] and an empty dependency_graph (GTRK-02)', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    const result = await getTrackService(pool, config, {
      project_id: projectId,
      track_id: trackId,
    });

    expect(result.items).toEqual([]);
    expect(result.dependency_graph).toEqual({ nodes: [], edges: [] });
  });

  it('positive: track.depends_on_track_ids reflects track-level dependencies', async () => {
    const { projectId, trackId: prereqId } = await makeProjectAndTrack();
    const dependent = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Depends on prereq',
      depends_on: [prereqId],
      source_doc_ref: undefined,
    });

    const result = await getTrackService(pool, config, {
      project_id: projectId,
      track_id: dependent.track_id,
    });

    expect(result.track.depends_on_track_ids).toEqual([prereqId]);
  });

  it('negative: 404 when project does not exist (GTRK-06)', async () => {
    const { trackId } = await makeProjectAndTrack();
    await expect(
      getTrackService(pool, config, { project_id: UNKNOWN_UUID, track_id: trackId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when track does not exist in this project (GTRK-07)', async () => {
    const { projectId } = await makeProjectAndTrack();
    await expect(
      getTrackService(pool, config, { project_id: projectId, track_id: UNKNOWN_UUID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when track_id belongs to a different project than project_id (GTRK-08/09)', async () => {
    // This build has one flat API-token pool with no per-project scoping
    // (src/server/auth.ts, docs/TRD.md §4) — the only real cross-project
    // isolation left to test is exactly this: a project_id/track_id pair
    // from two different projects, which findTrackById's
    // `WHERE id = $1 AND project_id = $2` already rejects.
    const other = await makeProjectAndTrack();
    const { projectId } = await makeProjectAndTrack();

    await expect(
      getTrackService(pool, config, { project_id: projectId, track_id: other.trackId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('positive: dependency_graph shows the full multi-hop item chain, not just direct deps (GTRK-10)', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const a = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'A',
      sequence_position: undefined,
      depends_on: [],
    });
    const b = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'B',
      sequence_position: undefined,
      depends_on: [a.item_id],
    });
    const c = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'C',
      sequence_position: undefined,
      depends_on: [b.item_id],
    });

    const result = await getTrackService(pool, config, {
      project_id: projectId,
      track_id: trackId,
    });

    expect(result.dependency_graph.edges).toEqual(
      expect.arrayContaining([
        { item_id: b.item_id, depends_on_item_id: a.item_id },
        { item_id: c.item_id, depends_on_item_id: b.item_id },
      ]),
    );
    expect(result.dependency_graph.nodes.map((n) => n.item_id).sort()).toEqual(
      [a.item_id, b.item_id, c.item_id].sort(),
    );
  });
});
