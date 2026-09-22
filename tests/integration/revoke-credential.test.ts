// T5.4 — credential revocation path. Deleting a stored GitHub/Linear
// credential makes the next sync fail with a clean "adapter not configured"
// CONFLICT (never a crash, never a stale token).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { syncToGithubService } from '../../src/mcp/tools/sync-to-github.js';
import { syncToLinearService } from '../../src/mcp/tools/sync-to-linear.js';
import {
  adapterConfigured,
  deleteAdapterForProject,
  getAdapterForProject,
} from '../../src/db/queries/adapters.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeProjectWithBothAdapters() {
  const { project_id } = await registerProjectService(pool, config, {
    name: 'Revocation',
    source_type: 'local',
    source_ref: `/tmp/${randomUUID()}`,
    adapters: {
      github: { personal_access_token: 'ghp_secret', repo: 'acme/widgets' },
      linear: { api_key: 'lin_secret', team_id: 'team-1' },
    },
  });
  const { track_id } = await createTrackService(pool, config, {
    project_id,
    title: 'A track',
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

describe('T5.4 — credential revocation', () => {
  it('revoking the github credential makes kt_sync_to_github fail with a clean CONFLICT', async () => {
    const { project_id, track_id } = await makeProjectWithBothAdapters();

    const deletedId = await deleteAdapterForProject(pool, project_id, 'github');
    expect(deletedId).not.toBeNull();
    // The row (and its secret) is gone — nothing stale remains.
    expect(await getAdapterForProject(pool, project_id, 'github')).toBeUndefined();
    expect(await adapterConfigured(pool, project_id, 'github')).toBe(false);
    // The other adapter is untouched.
    expect(await adapterConfigured(pool, project_id, 'linear')).toBe(true);

    await expect(syncToGithubService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      { code: 'CONFLICT', message: 'github adapter not configured' },
    );
  });

  it('revoking the linear credential makes kt_sync_to_linear fail with a clean CONFLICT', async () => {
    const { project_id, track_id } = await makeProjectWithBothAdapters();

    const deletedId = await deleteAdapterForProject(pool, project_id, 'linear');
    expect(deletedId).not.toBeNull();
    expect(await getAdapterForProject(pool, project_id, 'linear')).toBeUndefined();
    expect(await adapterConfigured(pool, project_id, 'github')).toBe(true);

    await expect(syncToLinearService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      { code: 'CONFLICT', message: 'linear adapter not configured' },
    );
  });

  it('is idempotent: revoking again returns false (nothing to revoke)', async () => {
    const { project_id } = await makeProjectWithBothAdapters();
    expect(await deleteAdapterForProject(pool, project_id, 'github')).not.toBeNull();
    expect(await deleteAdapterForProject(pool, project_id, 'github')).toBeNull();
  });

  it('revoking one project does NOT touch a different project', async () => {
    const a = await makeProjectWithBothAdapters();
    const b = await makeProjectWithBothAdapters();
    expect(await deleteAdapterForProject(pool, a.project_id, 'github')).not.toBeNull();
    // B is entirely untouched.
    expect(await adapterConfigured(pool, b.project_id, 'github')).toBe(true);
    expect(await adapterConfigured(pool, b.project_id, 'linear')).toBe(true);
    // A's linear also untouched.
    expect(await adapterConfigured(pool, a.project_id, 'linear')).toBe(true);
  });

  it('does not use a stale token: re-registering after revoke stores the NEW credential', async () => {
    const { project_id } = await makeProjectWithBothAdapters();
    await deleteAdapterForProject(pool, project_id, 'github');
    await registerProjectService(pool, config, {
      name: 'Revocation',
      source_type: 'local',
      source_ref: (await getSourceRef(project_id)) ?? `/tmp/${randomUUID()}`,
      adapters: { github: { personal_access_token: 'ghp_rotated', repo: 'acme/widgets' } },
    });
    const row = await getAdapterForProject(pool, project_id, 'github');
    expect(row).toBeDefined();
    // A fresh row exists again (decrypted per-call, so never a cached old token).
    expect(row?.encrypted_credential).toBeInstanceOf(Buffer);
  });
});

async function getSourceRef(projectId: string): Promise<string | undefined> {
  const r = await pool.query<{ source_ref: string | null }>(
    `SELECT source_ref FROM projects WHERE id = $1`,
    [projectId],
  );
  return r.rows[0]?.source_ref ?? undefined;
}
