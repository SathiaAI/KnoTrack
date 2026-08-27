import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { updateItemStatusService } from '../../src/mcp/tools/update-item-status.js';
import { findItemInProject } from '../../src/db/queries/items.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeProjectTrackAndItem(): Promise<{
  projectId: string;
  trackId: string;
  itemId: string;
}> {
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
  const { item_id } = await createItemService(pool, config, {
    project_id,
    track_id,
    title: 'Item',
    sequence_position: undefined,
    depends_on: [],
  });
  return { projectId: project_id, trackId: track_id, itemId: item_id };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_update_item_status', () => {
  it('positive: pending -> in_progress is unconstrained', async () => {
    const { projectId, itemId } = await makeProjectTrackAndItem();
    const result = await updateItemStatusService(pool, config, {
      project_id: projectId,
      item_id: itemId,
      status: 'in_progress',
    });
    expect(result).toEqual({ ok: true });
    const row = await pool.query('SELECT status FROM items WHERE id = $1', [itemId]);
    expect(row.rows[0]?.status).toBe('in_progress');
  });

  it('positive: pending -> blocked is unconstrained', async () => {
    const { projectId, itemId } = await makeProjectTrackAndItem();
    const result = await updateItemStatusService(pool, config, {
      project_id: projectId,
      item_id: itemId,
      status: 'blocked',
    });
    expect(result).toEqual({ ok: true });
    const row = await pool.query('SELECT status FROM items WHERE id = $1', [itemId]);
    expect(row.rows[0]?.status).toBe('blocked');
  });

  it('positive: done -> done no-op is unconstrained, even with an unmet dependency', async () => {
    const { projectId, trackId, itemId: prereqId } = await makeProjectTrackAndItem();
    const dependent = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Dependent',
      sequence_position: undefined,
      depends_on: [prereqId],
    });
    // Force the dependent item into 'done' directly, bypassing the
    // service check, to simulate data where the dependency invariant no
    // longer holds (e.g. the prereq was reopened after the fact). TRD
    // §3.11: a done -> done transition performs no dependency check at
    // all, so re-asserting 'done' here must still succeed.
    await pool.query('UPDATE items SET status = $1 WHERE id = $2', ['done', dependent.item_id]);

    const result = await updateItemStatusService(pool, config, {
      project_id: projectId,
      item_id: dependent.item_id,
      status: 'done',
    });
    expect(result).toEqual({ ok: true });
  });

  it('positive: done transition succeeds when the item has zero dependencies', async () => {
    const { projectId, itemId } = await makeProjectTrackAndItem();
    const result = await updateItemStatusService(pool, config, {
      project_id: projectId,
      item_id: itemId,
      status: 'done',
    });
    expect(result).toEqual({ ok: true });
    const row = await pool.query('SELECT status FROM items WHERE id = $1', [itemId]);
    expect(row.rows[0]?.status).toBe('done');
  });

  it('positive: done transition succeeds when all dependencies are already done', async () => {
    const { projectId, trackId, itemId: prereqId } = await makeProjectTrackAndItem();
    const dependent = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Dependent',
      sequence_position: undefined,
      depends_on: [prereqId],
    });

    await updateItemStatusService(pool, config, {
      project_id: projectId,
      item_id: prereqId,
      status: 'done',
    });

    const result = await updateItemStatusService(pool, config, {
      project_id: projectId,
      item_id: dependent.item_id,
      status: 'done',
    });
    expect(result).toEqual({ ok: true });
  });

  it('negative: 409 when marking done with one unmet dependency (singular wording)', async () => {
    const { projectId, trackId, itemId: prereqId } = await makeProjectTrackAndItem();
    const dependent = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Dependent',
      sequence_position: undefined,
      depends_on: [prereqId],
    });

    await expect(
      updateItemStatusService(pool, config, {
        project_id: projectId,
        item_id: dependent.item_id,
        status: 'done',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'cannot mark item done: 1 unmet dependency',
      details: { item_id: dependent.item_id, unmet_item_ids: [prereqId] },
    });
  });

  it('negative: 409 when marking done with two unmet dependencies (plural wording)', async () => {
    const { projectId, trackId, itemId: prereqA } = await makeProjectTrackAndItem();
    const prereqB = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Prereq B',
      sequence_position: undefined,
      depends_on: [],
    });
    const dependent = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Dependent',
      sequence_position: undefined,
      depends_on: [prereqA, prereqB.item_id],
    });

    await expect(
      updateItemStatusService(pool, config, {
        project_id: projectId,
        item_id: dependent.item_id,
        status: 'done',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'cannot mark item done: 2 unmet dependencies',
    });

    try {
      await updateItemStatusService(pool, config, {
        project_id: projectId,
        item_id: dependent.item_id,
        status: 'done',
      });
      throw new Error('expected rejection');
    } catch (error) {
      const details = (error as { details?: { unmet_item_ids?: string[] } }).details;
      expect(details?.unmet_item_ids?.slice().sort()).toEqual([prereqA, prereqB.item_id].sort());
    }
  });

  it('negative: 404 when project does not exist', async () => {
    const { itemId } = await makeProjectTrackAndItem();
    await expect(
      updateItemStatusService(pool, config, {
        project_id: UNKNOWN_UUID,
        item_id: itemId,
        status: 'in_progress',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when item does not exist', async () => {
    const { projectId } = await makeProjectTrackAndItem();
    await expect(
      updateItemStatusService(pool, config, {
        project_id: projectId,
        item_id: UNKNOWN_UUID,
        status: 'in_progress',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 404 when item_id belongs to a different project than project_id', async () => {
    // One flat API-token pool, no per-project scoping (src/server/auth.ts,
    // TRD §4) — mirrors get-track.test.ts's GTRK-08/09 cross-project case.
    const other = await makeProjectTrackAndItem();
    const { projectId } = await makeProjectTrackAndItem();

    await expect(
      updateItemStatusService(pool, config, {
        project_id: projectId,
        item_id: other.itemId,
        status: 'in_progress',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // adversarial-review P2: findItemInProject's read of the item's current
  // status (used to decide whether the done -> done no-op exemption
  // applies) was unlocked — a concurrent status change on the same item
  // could commit between that read and this call's own write, letting a
  // real pending -> done transition slip past the unmet-dependency check
  // because an earlier snapshot of the row looked like a no-op. Fixed by
  // taking `FOR UPDATE` on the item row inside the same transaction as
  // the eventual UPDATE. Deterministic test of the actual mechanism the
  // fix relies on — a Postgres row lock blocking a second transaction
  // until the first commits is a hard guarantee, not a timing race — same
  // style as create-item.test.ts's lockTrackForSequenceAssignment test.
  it('negative: findItemInProject serializes concurrent holders on the same item', async () => {
    const { projectId, itemId } = await makeProjectTrackAndItem();
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    let bLock: Promise<void> | undefined;
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      await findItemInProject(clientA, projectId, itemId);

      let bAcquired = false;
      bLock = findItemInProject(clientB, projectId, itemId).then(() => {
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
      await clientA.query('ROLLBACK').catch(() => {});
      await clientB.query('ROLLBACK').catch(() => {});
      clientA.release();
      clientB.release();
    }
  });

  // adversarial-review P2: getUnmetDependencyIds's FOR UPDATE lock over
  // dependency rows had no ORDER BY, so two transactions locking
  // overlapping-but-oppositely-ordered dependency sets could deadlock
  // (Postgres aborts one with a 40P01 error, surfaced by runTool as an
  // opaque 500). Fixed by sorting the locked rows by id. This is a
  // best-effort functional check, not a guaranteed repro of the old
  // deadlock (that would need explicit manual lock-order control, as in
  // the primitive-level test above) — it asserts the fixed, correct
  // outcome: concurrent done-transitions over items with reversed
  // dependency-declaration order both complete without error.
  it('positive: concurrent done-transitions on items with overlapping, oppositely-ordered dependencies both succeed without deadlocking', async () => {
    const { projectId, trackId } = await makeProjectTrackAndItem();
    const x = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'X',
      sequence_position: undefined,
      depends_on: [],
    });
    const y = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Y',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = ANY($1::uuid[])`, [
      [x.item_id, y.item_id],
    ]);
    const a = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'A depends on [X, Y]',
      sequence_position: undefined,
      depends_on: [x.item_id, y.item_id],
    });
    const b = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'B depends on [Y, X]',
      sequence_position: undefined,
      depends_on: [y.item_id, x.item_id],
    });

    const results = await Promise.all(
      [a.item_id, b.item_id].map((itemId) =>
        updateItemStatusService(pool, config, {
          project_id: projectId,
          item_id: itemId,
          status: 'done',
        }),
      ),
    );

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    const rows = await pool.query<{ status: string }>(
      `SELECT status FROM items WHERE id = ANY($1::uuid[])`,
      [[a.item_id, b.item_id]],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['done', 'done']);
  });
});
