import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { lockTrackForSequenceAssignment } from '../../src/db/queries/items.js';
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

describe('kt_create_item', () => {
  it('positive: creates an item with auto-assigned sequence_position starting at 1', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const first = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'First item',
      sequence_position: undefined,
      depends_on: [],
    });
    const second = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Second item',
      sequence_position: undefined,
      depends_on: [],
    });

    const rows = await pool.query(
      'SELECT id, sequence_position FROM items WHERE track_id = $1 ORDER BY sequence_position',
      [trackId],
    );
    expect(rows.rows).toEqual([
      { id: first.item_id, sequence_position: 1 },
      { id: second.item_id, sequence_position: 2 },
    ]);
  });

  it('positive: accepts a same-track depends_on list', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const base = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Base',
      sequence_position: undefined,
      depends_on: [],
    });
    const dependent = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Dependent',
      sequence_position: undefined,
      depends_on: [base.item_id],
    });
    const edge = await pool.query(
      'SELECT * FROM item_dependencies WHERE item_id = $1 AND depends_on_item_id = $2',
      [dependent.item_id, base.item_id],
    );
    expect(edge.rowCount).toBe(1);
  });

  // adversarial-review P1: an explicit sequence_position already occupied
  // by another item used to be inserted unchanged, producing a duplicate
  // declared position instead of the documented application-owned
  // ordering. The fix renumbers by shifting everything at or after the
  // requested position one later, matching how inserting into the middle
  // of an ordered list works.
  it('positive: an occupied explicit sequence_position shifts subsequent items instead of colliding', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const a = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'A',
      sequence_position: 1,
      depends_on: [],
    });
    const b = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'B',
      sequence_position: 2,
      depends_on: [],
    });
    const c = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'C (inserted at 1)',
      sequence_position: 1,
      depends_on: [],
    });

    const rows = await pool.query<{ id: string; sequence_position: number }>(
      'SELECT id, sequence_position FROM items WHERE track_id = $1 ORDER BY sequence_position',
      [trackId],
    );
    expect(rows.rows).toEqual([
      { id: c.item_id, sequence_position: 1 },
      { id: a.item_id, sequence_position: 2 },
      { id: b.item_id, sequence_position: 3 },
    ]);
  });

  it('negative: 404 when track does not exist in project', async () => {
    const { projectId } = await makeProjectAndTrack();
    await expect(
      createItemService(pool, config, {
        project_id: projectId,
        track_id: UNKNOWN_UUID,
        title: 'X',
        sequence_position: undefined,
        depends_on: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when a depends_on id does not exist as an item at all', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    await expect(
      createItemService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        title: 'X',
        sequence_position: undefined,
        depends_on: [UNKNOWN_UUID],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 422 (VALIDATION_ERROR) when a depends_on item exists but belongs to a different track', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const otherTrack = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Other track',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const itemInOtherTrack = await createItemService(pool, config, {
      project_id: projectId,
      track_id: otherTrack.track_id,
      title: 'Lives elsewhere',
      sequence_position: undefined,
      depends_on: [],
    });

    await expect(
      createItemService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        title: 'X',
        sequence_position: undefined,
        depends_on: [itemInOtherTrack.item_id],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // adversarial-review test_quality-1: the service-layer wiring of the
  // item-level cycle check (existingEdges fetched scoped to the right
  // track, the sentinel used correctly, the 409 actually thrown) had no
  // integration test — only the pure wouldCreateCycle() function was unit
  // tested. Mirrors the equivalent test in create-track.test.ts.
  it('negative: 409 dependency cycle — pre-existing cyclic item_dependencies data is rejected defensively', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const a = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'A',
      sequence_position: undefined,
      depends_on: [],
    });
    const b = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'B',
      sequence_position: undefined,
      depends_on: [],
    });
    // Force a genuine cycle in stored data by inserting both directions
    // directly, bypassing the service (which would itself reject the
    // second edge — this simulates data that predates the invariant).
    await pool.query(
      'INSERT INTO item_dependencies (item_id, depends_on_item_id) VALUES ($1, $2)',
      [a.item_id, b.item_id],
    );
    await pool.query(
      'INSERT INTO item_dependencies (item_id, depends_on_item_id) VALUES ($1, $2)',
      [b.item_id, a.item_id],
    );

    await expect(
      createItemService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        title: 'C (unrelated)',
        sequence_position: undefined,
        depends_on: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  // adversarial-review correctness-1: getMaxSequencePosition() followed by
  // insertItem() was a read-then-write with no lock and no unique
  // constraint — two concurrent kt_create_item calls on the same track
  // could both read the same MAX and insert the same sequence_position.
  // Deterministic test of the actual mechanism the fix relies on: a
  // SELECT ... FOR UPDATE on the track row must block a second
  // transaction until the first commits (this is a hard Postgres
  // guarantee, not a timing race — the assertion holds every run).
  it('negative: lockTrackForSequenceAssignment serializes concurrent holders on the same track', async () => {
    const { trackId } = await makeProjectAndTrack();
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      await lockTrackForSequenceAssignment(clientA, trackId);

      let bAcquired = false;
      const bLock = lockTrackForSequenceAssignment(clientB, trackId).then(() => {
        bAcquired = true;
      });

      // B must still be blocked while A holds the lock.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(bAcquired).toBe(false);

      await clientA.query('COMMIT');
      await bLock;
      expect(bAcquired).toBe(true);

      await clientB.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  // Functional check that the real wiring in createItemService produces
  // distinct sequence_position values under concurrent auto-assigns, not
  // just that the lock primitive itself blocks. With the fix, every
  // sequence_position is guaranteed distinct (the lock forces the
  // reads-then-writes to serialize); this is deterministic given the fix,
  // even though a run without the fix would only be very likely — not
  // logically guaranteed — to surface a duplicate.
  it('positive: concurrent auto-assigned creates on the same track never collide', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createItemService(pool, config, {
          project_id: projectId,
          track_id: trackId,
          title: `Concurrent ${i}`,
          sequence_position: undefined,
          depends_on: [],
        }),
      ),
    );
    const rows = await pool.query<{ sequence_position: number }>(
      'SELECT sequence_position FROM items WHERE track_id = $1',
      [trackId],
    );
    expect(rows.rows).toHaveLength(8);
    const positions = rows.rows.map((r) => r.sequence_position);
    expect(new Set(positions).size).toBe(8);
    expect([...positions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    void results;
  });
});
