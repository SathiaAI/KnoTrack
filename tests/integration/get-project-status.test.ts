import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getProjectStatusService } from '../../src/mcp/tools/get-project-status.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { recordSessionSummaryService } from '../../src/mcp/tools/record-session-summary.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_get_project_status', () => {
  it('positive: rolls up tracks with item counts and recent events', async () => {
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
      source_doc_ref: undefined,
    });
    const item1 = await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'Item 1',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [item1.item_id]);
    await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'Item 2',
      sequence_position: undefined,
      depends_on: [],
    });
    await recordSessionSummaryService(pool, config, {
      project_id,
      track_id,
      summary_text: 'Wired up JWT refresh flow.',
      files_touched: [],
      items_touched: [],
    });

    const status = await getProjectStatusService(pool, config, { project_id });

    expect(status.tracks).toHaveLength(1);
    expect(status.tracks[0]).toMatchObject({
      track_id,
      title: 'Auth overhaul',
      status: 'on_track',
      item_counts: { pending: 1, in_progress: 0, done: 1, blocked: 0 },
    });
    expect(status.recent_events).toHaveLength(1);
    expect(status.recent_events[0]).toMatchObject({
      event_type: 'session_summary',
      track_id,
      summary_text: 'Wired up JWT refresh flow.',
    });
    expect(status.drift_flags).toEqual([]);
  });

  it('negative: 404 when project does not exist', async () => {
    await expect(
      getProjectStatusService(pool, config, { project_id: UNKNOWN_UUID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
