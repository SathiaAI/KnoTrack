import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { syncToLinearService } from '../../src/mcp/tools/sync-to-linear.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { upsertAdapter } from '../../src/db/queries/adapters.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeProjectAndTrack(): Promise<{ project_id: string; track_id: string }> {
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
  return { project_id, track_id };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_sync_to_linear (T2.14 stub)', () => {
  it('negative: CONFLICT (linear-specific) when no linear adapter is configured, even with a github adapter present', async () => {
    const { project_id, track_id } = await makeProjectAndTrack();
    await upsertAdapter(pool, {
      projectId: project_id,
      type: 'github',
      encryptedCredential: Buffer.from('github-secret'),
      config: {},
    });
    await expect(syncToLinearService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        message: 'linear adapter not configured',
        details: { adapter: 'linear' },
      },
    );
  });

  it('negative: 404 when the project does not exist', async () => {
    const { track_id } = await makeProjectAndTrack();
    await expect(
      syncToLinearService(pool, config, { project_id: UNKNOWN_UUID, track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when the track does not exist in the project', async () => {
    const { project_id } = await makeProjectAndTrack();
    await expect(
      syncToLinearService(pool, config, { project_id, track_id: UNKNOWN_UUID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when the track belongs to a different project (no cross-project leak)', async () => {
    const other = await makeProjectAndTrack();
    const { project_id } = await makeProjectAndTrack();
    await expect(
      syncToLinearService(pool, config, { project_id, track_id: other.track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('edge: INTERNAL_ERROR "not available in this build" when a linear adapter row already exists', async () => {
    const { project_id, track_id } = await makeProjectAndTrack();
    await upsertAdapter(pool, {
      projectId: project_id,
      type: 'linear',
      encryptedCredential: Buffer.from('linear-secret'),
      config: {},
    });
    await expect(syncToLinearService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      {
        code: 'INTERNAL_ERROR',
        message: 'linear sync is not available in this build',
      },
    );
  });
});
