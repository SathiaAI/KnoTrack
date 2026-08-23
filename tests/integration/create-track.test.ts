import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { KtError } from '../../src/mcp/errors.js';
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

describe('kt_create_track', () => {
  it('positive: no depends_on -> status on_track', async () => {
    const projectId = await makeProject();
    const result = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Auth overhaul',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const row = await pool.query('SELECT status FROM tracks WHERE id = $1', [result.track_id]);
    expect(row.rows[0].status).toBe('on_track');
  });

  it('positive: depends_on an unfinished track -> status blocked', async () => {
    const projectId = await makeProject();
    const prereq = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Prereq (not done)',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const result = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Depends on prereq',
      depends_on: [prereq.track_id],
      source_doc_ref: undefined,
    });
    const row = await pool.query('SELECT status FROM tracks WHERE id = $1', [result.track_id]);
    expect(row.rows[0].status).toBe('blocked');
  });

  it('positive: depends_on an already-done track -> status on_track', async () => {
    const projectId = await makeProject();
    const prereq = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Prereq (done)',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await pool.query(`UPDATE tracks SET status = 'done' WHERE id = $1`, [prereq.track_id]);

    const result = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Depends on done prereq',
      depends_on: [prereq.track_id],
      source_doc_ref: undefined,
    });
    const row = await pool.query('SELECT status FROM tracks WHERE id = $1', [result.track_id]);
    expect(row.rows[0].status).toBe('on_track');
  });

  it('negative: 404 when project does not exist', async () => {
    await expect(
      createTrackService(pool, config, {
        project_id: UNKNOWN_UUID,
        title: 'X',
        depends_on: [],
        source_doc_ref: undefined,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<KtError>);
  });

  it('negative: 404 when a depends_on track id does not exist in the project', async () => {
    const projectId = await makeProject();
    await expect(
      createTrackService(pool, config, {
        project_id: projectId,
        title: 'X',
        depends_on: [UNKNOWN_UUID],
        source_doc_ref: undefined,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 409 dependency cycle — pre-existing cyclic track_dependencies data is rejected defensively', async () => {
    // TRD §3.6 notes that with the v1 tool set alone, a cycle can never
    // arise through legitimate kt_create_track calls (a brand-new track
    // can only point at already-existing tracks, never the reverse) — the
    // check exists to fail safe against data that predates the invariant
    // or was written directly. We simulate that here by seeding a cyclic
    // track_dependencies pair directly, bypassing the service.
    const projectId = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [],
      source_doc_ref: undefined,
    });
    // A -> B already exists structurally as a legitimate edge; force B -> A
    // directly to create a genuine cycle in stored data.
    await pool.query(
      'INSERT INTO track_dependencies (track_id, depends_on_track_id) VALUES ($1, $2)',
      [a.track_id, b.track_id],
    );
    await pool.query(
      'INSERT INTO track_dependencies (track_id, depends_on_track_id) VALUES ($1, $2)',
      [b.track_id, a.track_id],
    );

    await expect(
      createTrackService(pool, config, {
        project_id: projectId,
        title: 'C (unrelated)',
        depends_on: [],
        source_doc_ref: undefined,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
