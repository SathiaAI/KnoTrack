import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordSessionSummaryService } from '../../src/mcp/tools/record-session-summary.js';
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

describe('kt_record_session_summary', () => {
  it('positive: inserts an event and returns its event_id', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const result = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Did the thing.',
      files_touched: ['src/index.ts'],
      items_touched: [],
    });
    expect(result.event_id).toMatch(/^[0-9a-f-]{36}$/i);
    const row = await pool.query('SELECT summary_text, files_touched FROM events WHERE id = $1', [
      result.event_id,
    ]);
    expect(row.rows[0].summary_text).toBe('Did the thing.');
    expect(row.rows[0].files_touched).toEqual(['src/index.ts']);
  });

  it('positive: scoped drift re-check raises an out_of_sequence flag when an item finished out of order', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const earlier = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add refresh endpoint',
      sequence_position: 1,
      depends_on: [],
    });
    const later = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add rotation tests',
      sequence_position: 2,
      depends_on: [],
    });
    // Later item finishes while the earlier one is still pending.
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [later.item_id]);
    void earlier;

    const result = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Finished rotation tests early.',
      files_touched: [],
      items_touched: [],
    });

    expect(result.drift_flags_raised).toHaveLength(1);
    expect(result.drift_flags_raised[0]).toMatchObject({ flag_type: 'OUT_OF_SEQUENCE' });

    // Calling it again must not re-raise a duplicate open flag for the
    // same item.
    const second = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Still finished early, second summary.',
      files_touched: [],
      items_touched: [],
    });
    expect(second.drift_flags_raised).toHaveLength(0);
  });

  it('negative: 404 when track does not exist in project', async () => {
    const { projectId } = await makeProjectAndTrack();
    await expect(
      recordSessionSummaryService(pool, config, {
        project_id: projectId,
        track_id: UNKNOWN_UUID,
        summary_text: 'x',
        files_touched: [],
        items_touched: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // adversarial-review reliability-4: findSequenceSkips is O(n^2) in the
  // track's item count and KNOTRACK_DRIFT_SCAN_ITEM_CAP was declared but
  // never enforced anywhere, so an oversized track could make this call
  // scan unboundedly. Uses a tiny cap override rather than the real
  // 5000-item default so the test stays fast.
  it('negative: 422 when the track has more items than driftScanItemCap allows', async () => {
    const cappedConfig = { ...config, driftScanItemCap: 3 };
    const { projectId, trackId } = await makeProjectAndTrack();
    for (let i = 0; i < 4; i += 1) {
      await createItemService(pool, cappedConfig, {
        project_id: projectId,
        track_id: trackId,
        title: `Item ${i}`,
        sequence_position: undefined,
        depends_on: [],
      });
    }

    await expect(
      recordSessionSummaryService(pool, cappedConfig, {
        project_id: projectId,
        track_id: trackId,
        summary_text: 'Too many items in this track.',
        files_touched: [],
        items_touched: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('negative: 422 when an items_touched id belongs to a different track', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const otherTrack = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Other track',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const itemElsewhere = await createItemService(pool, config, {
      project_id: projectId,
      track_id: otherTrack.track_id,
      title: 'Elsewhere',
      sequence_position: undefined,
      depends_on: [],
    });

    await expect(
      recordSessionSummaryService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        summary_text: 'x',
        files_touched: [],
        items_touched: [itemElsewhere.item_id],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
