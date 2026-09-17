import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
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

async function trackStatus(trackId: string): Promise<string> {
  const row = await pool.query<{ status: string }>(
    'SELECT status FROM track_readiness WHERE id = $1',
    [trackId],
  );
  const status = row.rows[0]?.status;
  if (status === undefined) throw new Error(`trackStatus: no track_readiness row for ${trackId}`);
  return status;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

async function makeDoneTrack(projectId: string, title: string): Promise<string> {
  // T2.16: status is derived, and an empty track is never `done` — a
  // track needs at least one item, all done, to read as `done`.
  const track = await createTrackService(pool, config, {
    project_id: projectId,
    title,
    depends_on: [],
    source_doc_ref: undefined,
  });
  const item = await createItemService(pool, config, {
    project_id: projectId,
    track_id: track.track_id,
    title: 'Only item',
    sequence_position: undefined,
    depends_on: [],
  });
  await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [item.item_id]);
  return track.track_id;
}

describe('kt_create_track', () => {
  it('positive: no depends_on -> status on_track', async () => {
    const projectId = await makeProject();
    const result = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Auth overhaul',
      depends_on: [],
      source_doc_ref: undefined,
    });
    expect(await trackStatus(result.track_id)).toBe('on_track');
  });

  it('positive (T2.16): a fresh, empty track is never `done`, even with no dependencies to block it', async () => {
    // Regression test for the "empty track (zero items) is never done"
    // rule (T2.16 final design doc §3) — own_done requires >= 1 item.
    const projectId = await makeProject();
    const result = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Empty',
      depends_on: [],
      source_doc_ref: undefined,
    });
    expect(await trackStatus(result.track_id)).toBe('on_track');
  });

  it('positive: depends_on an unfinished (empty) track -> status blocked, with a warning (not a hard gate)', async () => {
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
    expect(await trackStatus(result.track_id)).toBe('blocked');
    // T2.16 final design doc §4: an unfinished depends_on is a warning,
    // never a hard gate — creation still succeeds.
    expect(result.warnings).toEqual([
      expect.stringContaining(`not yet fully complete (effective_done=false): ${prereq.track_id}`),
    ]);
  });

  it('positive: depends_on an already-done track -> status on_track, no warning', async () => {
    const projectId = await makeProject();
    const prereqId = await makeDoneTrack(projectId, 'Prereq (done)');

    const result = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Depends on done prereq',
      depends_on: [prereqId],
      source_doc_ref: undefined,
    });
    expect(await trackStatus(result.track_id)).toBe('on_track');
    expect(result.warnings).toBeUndefined();
  });

  it('positive (T2.16): status `done` is reachable — the regression test for the original defect', async () => {
    // The original bug this whole redesign exists to fix: no write path
    // ever set tracks.status = 'done', so a track could never complete
    // and a dependent could never unblock. This must now be reachable.
    const projectId = await makeProject();
    const doneId = await makeDoneTrack(projectId, 'Fully done');
    expect(await trackStatus(doneId)).toBe('done');

    const dependent = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Depends on the done track',
      depends_on: [doneId],
      source_doc_ref: undefined,
    });
    expect(await trackStatus(dependent.track_id)).toBe('on_track');
    expect(dependent.warnings).toBeUndefined();
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

  it('negative (T2.16): a BEFORE INSERT trigger rejects a direct cyclic track_dependencies insert', async () => {
    // migrations/006_derived_track_status.sql adds a database-level
    // defense against a multi-hop dependency cycle, closing a gap a plain
    // CHECK constraint can't see (it only sees the one row being
    // inserted) — this is on top of, not instead of, create-track.ts's
    // own application-level check (still exercised as "pre-existing
    // data" below with the trigger disabled, since a genuine cycle can
    // never arise through legitimate kt_create_track calls alone — TRD
    // §3.6 — so the app-level check has nothing else to defend against).
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
      depends_on: [a.track_id],
      source_doc_ref: undefined,
    });
    // B -> A already exists (legitimate edge, created above); A -> B would
    // close a cycle.
    await expect(
      pool.query(
        'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
        [a.track_id, b.track_id, projectId],
      ),
    ).rejects.toThrow(/dependency cycle/);
  });

  it("negative: 409 dependency cycle — pre-trigger legacy cyclic track_dependencies data is rejected defensively by create-track.ts's own check", async () => {
    // Simulates data that predates both the app-level check (create-
    // track.ts's wouldCreateCycle) and the DB-level trigger above — the
    // trigger is disabled for this one seeding step to construct a state
    // that could otherwise only arise from data older than this
    // migration, then re-enabled immediately after.
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
    await pool.query(
      'ALTER TABLE track_dependencies DISABLE TRIGGER trg_track_dependencies_no_cycle',
    );
    // A -> B already exists structurally as a legitimate edge; force B -> A
    // directly to create a genuine cycle in stored data.
    await pool.query(
      'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
      [a.track_id, b.track_id, projectId],
    );
    await pool.query(
      'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
      [b.track_id, a.track_id, projectId],
    );
    await pool.query(
      'ALTER TABLE track_dependencies ENABLE TRIGGER trg_track_dependencies_no_cycle',
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
