import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { syncToGithubService } from '../../src/mcp/tools/sync-to-github.js';
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

describe('kt_sync_to_github (T2.13 stub)', () => {
  // TEST_CASES GHSY-03: a linear adapter is present but no github one —
  // the error must name github specifically, not fail generically.
  it('negative: CONFLICT (github-specific) when no github adapter is configured, even with a linear adapter present', async () => {
    const { project_id, track_id } = await makeProjectAndTrack();
    await upsertAdapter(pool, {
      projectId: project_id,
      type: 'linear',
      encryptedCredential: Buffer.from('linear-secret'),
      config: {},
    });
    await expect(syncToGithubService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        message: 'github adapter not configured',
        details: { adapter: 'github' },
      },
    );
  });

  it('negative: 404 when the project does not exist', async () => {
    const { track_id } = await makeProjectAndTrack();
    await expect(
      syncToGithubService(pool, config, { project_id: UNKNOWN_UUID, track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when the track does not exist in the project', async () => {
    const { project_id } = await makeProjectAndTrack();
    await expect(
      syncToGithubService(pool, config, { project_id, track_id: UNKNOWN_UUID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when the track belongs to a different project (no cross-project leak)', async () => {
    const other = await makeProjectAndTrack();
    const { project_id } = await makeProjectAndTrack();
    await expect(
      syncToGithubService(pool, config, { project_id, track_id: other.track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // Only reachable via fixtures / manual SQL in this build (no MCP tool
  // provisions an adapter until T5); the stub must not fall through to a
  // false success or claim "not configured".
  it('edge: INTERNAL_ERROR "not available in this build" when a github adapter row already exists', async () => {
    const { project_id, track_id } = await makeProjectAndTrack();
    await upsertAdapter(pool, {
      projectId: project_id,
      type: 'github',
      encryptedCredential: Buffer.from('github-secret'),
      config: {},
    });
    await expect(syncToGithubService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      {
        code: 'INTERNAL_ERROR',
        message: 'github sync is not available in this build',
      },
    );
  });
});
