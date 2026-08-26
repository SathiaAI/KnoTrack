import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getNextStepsService } from '../../src/mcp/tools/get-next-steps.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
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

async function insertItemRaw(
  trackId: string,
  opts: { title: string; sequencePosition: number; createdAt: string; status?: string },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO items (track_id, title, sequence_position, status, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [trackId, opts.title, opts.sequencePosition, opts.status ?? 'pending', opts.createdAt],
  );
  return result.rows[0]!.id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_get_next_steps', () => {
  it('positive: recommends a dependency-free item with the no-dependencies reason template', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Auth overhaul',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const item = await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Add refresh endpoint',
      sequence_position: undefined,
      depends_on: [],
    });

    const result = await getNextStepsService(pool, config, { project_id: projectId });

    expect(result.recommended_items).toEqual([
      {
        item_id: item.item_id,
        title: 'Add refresh endpoint',
        track_id: track.track_id,
        track_title: 'Auth overhaul',
        reason: 'No dependencies — ready to start in track "Auth overhaul".',
      },
    ]);
  });

  it('positive: recommends an item whose dependency is done, with the has-dependencies reason template', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Auth overhaul',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const dep = await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Add refresh endpoint',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [dep.item_id]);
    const ready = await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Add rotation tests',
      sequence_position: undefined,
      depends_on: [dep.item_id],
    });

    const result = await getNextStepsService(pool, config, { project_id: projectId });

    expect(result.recommended_items).toEqual([
      {
        item_id: ready.item_id,
        title: 'Add rotation tests',
        track_id: track.track_id,
        track_title: 'Auth overhaul',
        reason: 'All 1 dependency complete — next up in track "Auth overhaul".',
      },
    ]);
  });

  it('negative: excludes an item with an unmet dependency', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const dep = await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Not done yet',
      sequence_position: undefined,
      depends_on: [],
    });
    await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Blocked on dep',
      sequence_position: undefined,
      depends_on: [dep.item_id],
    });

    const result = await getNextStepsService(pool, config, { project_id: projectId });

    // Only `dep` itself (dependency-free) should be recommended; the
    // item depending on it is excluded since `dep` isn't done.
    expect(result.recommended_items).toHaveLength(1);
    expect(result.recommended_items[0]?.item_id).toBe(dep.item_id);
  });

  it('negative: excludes every item in a track whose stored status is blocked, even if individually ready', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Blocked track',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Ready in isolation',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE tracks SET status = 'blocked' WHERE id = $1`, [track.track_id]);

    const result = await getNextStepsService(pool, config, { project_id: projectId });

    expect(result.recommended_items).toEqual([]);
  });

  it('positive: orders on_track before pivot_pending, then sequence_position ascending, then created_at ascending', async () => {
    const projectId = await makeProject();
    const trackA = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'On track',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const trackB = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Pivot track',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await pool.query(`UPDATE tracks SET status = 'pivot_pending' WHERE id = $1`, [trackB.track_id]);

    // Deliberately seeded so that a naive "earliest created_at wins"
    // implementation would rank these in the wrong order — only the
    // correct (track priority, then sequence_position, then created_at)
    // ordering produces [earlySeq1, lateSeq1, seq2, pivotItem].
    const pivotItem = await insertItemRaw(trackB.track_id, {
      title: 'Pivot item',
      sequencePosition: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const seq2 = await insertItemRaw(trackA.track_id, {
      title: 'Seq 2',
      sequencePosition: 2,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const lateSeq1 = await insertItemRaw(trackA.track_id, {
      title: 'Seq 1, later created_at',
      sequencePosition: 1,
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    const earlySeq1 = await insertItemRaw(trackA.track_id, {
      title: 'Seq 1, earlier created_at',
      sequencePosition: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await getNextStepsService(pool, config, { project_id: projectId });

    expect(result.recommended_items.map((r) => r.item_id)).toEqual([
      earlySeq1,
      lateSeq1,
      seq2,
      pivotItem,
    ]);
  });

  it('positive: caps the result at KNOTRACK_NEXT_STEPS_LIMIT', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });
    for (let i = 1; i <= 6; i++) {
      await insertItemRaw(track.track_id, {
        title: `Item ${i}`,
        sequencePosition: i,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }

    const smallLimitConfig = { ...config, nextStepsLimit: 3 };
    const result = await getNextStepsService(pool, smallLimitConfig, { project_id: projectId });

    expect(result.recommended_items).toHaveLength(3);
    expect(result.recommended_items.map((r) => r.title)).toEqual(['Item 1', 'Item 2', 'Item 3']);
  });

  it('negative: 404 when project does not exist', async () => {
    await expect(
      getNextStepsService(pool, config, { project_id: UNKNOWN_UUID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
