// adversarial-review test_quality-5 (docs/ROADMAP.md T9.x): every real
// service function that takes a project_id already looks it up via
// findActiveProjectById (`WHERE deleted_at IS NULL`), so a soft-deleted
// project should already 404 everywhere — but no test verified that across
// every service function, only implicitly (if at all) for some. This
// exercises all four implemented service functions that take a project_id
// against a project row with `deleted_at` set, so a regression in any one
// of them (e.g. a future function that queries `projects` directly instead
// of going through findActiveProjectById) would be caught here.
//
// kt_register_project is deliberately not included: it never accepts an
// existing project_id as input (it upserts by (source_type, source_ref)),
// so "reject a soft-deleted project_id" doesn't apply to it the same way.
// kt_update_item_status and kt_record_decision are still stubs
// (src/mcp/tools/stubs.ts) and have no service function to exercise yet.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getProjectStatusService } from '../../src/mcp/tools/get-project-status.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { recordSessionSummaryService } from '../../src/mcp/tools/record-session-summary.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeSoftDeletedProjectWithTrackAndItem(): Promise<{
  projectId: string;
  trackId: string;
}> {
  const { project_id } = await registerProjectService(pool, config, {
    name: 'Soon deleted',
    source_type: 'local',
    source_ref: `/tmp/${crypto.randomUUID()}`,
    adapters: undefined,
  });
  const { track_id } = await createTrackService(pool, config, {
    project_id,
    title: 'A track',
    depends_on: [],
    source_doc_ref: undefined,
  });
  // Soft-delete after creating the track/item — findActiveProjectById is
  // the only thing standing between a deleted project and continued reads/
  // writes against it, so it must reject every call below despite the
  // track still physically existing in the DB.
  await pool.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [project_id]);
  return { projectId: project_id, trackId: track_id };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('a soft-deleted project (deleted_at set) is rejected by every service function', () => {
  it('kt_get_project_status: 404', async () => {
    const { projectId } = await makeSoftDeletedProjectWithTrackAndItem();
    await expect(
      getProjectStatusService(pool, config, { project_id: projectId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('kt_create_track: 404', async () => {
    const { projectId } = await makeSoftDeletedProjectWithTrackAndItem();
    await expect(
      createTrackService(pool, config, {
        project_id: projectId,
        title: 'Another track',
        depends_on: [],
        source_doc_ref: undefined,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('kt_create_item: 404', async () => {
    const { projectId, trackId } = await makeSoftDeletedProjectWithTrackAndItem();
    await expect(
      createItemService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        title: 'Another item',
        sequence_position: undefined,
        depends_on: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('kt_record_session_summary: 404', async () => {
    const { projectId, trackId } = await makeSoftDeletedProjectWithTrackAndItem();
    await expect(
      recordSessionSummaryService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        summary_text: 'x',
        files_touched: [],
        items_touched: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
