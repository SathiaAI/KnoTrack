import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDriftService } from '../../src/mcp/tools/check-drift.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
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

describe('kt_check_drift (T2.11 stub)', () => {
  it('positive: returns an empty scan with a no-heuristics note for a project with no tracks', async () => {
    const project_id = await makeProject();
    const result = await checkDriftService(pool, config, { project_id });
    expect(result.flags).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.scanned_track_count).toBe(0);
    expect(result.total_track_count).toBe(0);
    expect(result.note).toBe('no heuristics configured');
    expect(typeof result.scan_duration_ms).toBe('number');
  });

  it('positive: total_track_count reflects the project tracks while scanned_track_count stays 0', async () => {
    const project_id = await makeProject();
    await createTrackService(pool, config, {
      project_id,
      title: 'T1',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await createTrackService(pool, config, {
      project_id,
      title: 'T2',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const result = await checkDriftService(pool, config, { project_id });
    expect(result.total_track_count).toBe(2);
    expect(result.scanned_track_count).toBe(0);
    expect(result.flags).toEqual([]);
    expect(result.note).toBe('no heuristics configured');
  });

  it('negative: 404 when the project does not exist', async () => {
    await expect(
      checkDriftService(pool, config, { project_id: UNKNOWN_UUID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when the project is soft-deleted', async () => {
    const project_id = await makeProject();
    await pool.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [project_id]);
    await expect(checkDriftService(pool, config, { project_id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
