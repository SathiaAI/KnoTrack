import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordSessionSummaryService } from '../../src/mcp/tools/record-session-summary.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
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

describe('kt_record_session_summary', () => {
  it('positive: inserts an event and returns its event_id', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const result = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Did the thing.',
      files_touched: ['src/index.ts'],
      items_touched: [],
    });
    expect(result.event_id).toMatch(/^[0-9a-f-]{36}$/i);
    const row = await pool.query('SELECT summary_text, files_touched FROM events WHERE id = $1', [
      result.event_id,
    ]);
    expect(row.rows[0].summary_text).toBe('Did the thing.');
    expect(row.rows[0].files_touched).toEqual(['src/index.ts']);
  });

  it('positive: scoped drift re-check raises an out_of_sequence flag when an item finished out of order', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const earlier = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add refresh endpoint',
      sequence_position: 1,
      depends_on: [],
    });
    const later = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add rotation tests',
      sequence_position: 2,
      depends_on: [],
    });
    // Later item finishes while the earlier one is still pending.
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [later.item_id]);
    void earlier;

    const result = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Finished rotation tests early.',
      files_touched: [],
      items_touched: [],
    });

    expect(result.drift_flags_raised).toHaveLength(1);
    // adversarial-review P1: the public flag_type is TRD Appendix C's
    // 'SEQUENCE_SKIP', not an uppercased DB kind ('OUT_OF_SEQUENCE').
    expect(result.drift_flags_raised[0]).toMatchObject({ flag_type: 'SEQUENCE_SKIP' });

    // Calling it again must not re-raise a duplicate open flag for the
    // same item.
    const second = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Still finished early, second summary.',
      files_touched: [],
      items_touched: [],
    });
    expect(second.drift_flags_raised).toHaveLength(0);
  });

  // adversarial-review P1: bringing the earlier item back into sequence
  // used to leave the previously-raised flag open forever — nothing ever
  // wrote resolved_at. The scoped re-check must resolve it once the
  // condition it was raised for no longer holds.
  it('positive: a previously-raised flag is resolved once the out-of-sequence condition clears', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const earlier = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add refresh endpoint',
      sequence_position: 1,
      depends_on: [],
    });
    const later = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Add rotation tests',
      sequence_position: 2,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [later.item_id]);

    const first = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Finished rotation tests early.',
      files_touched: [],
      items_touched: [],
    });
    expect(first.drift_flags_raised).toHaveLength(1);
    const flagId = first.drift_flags_raised[0]?.flag_id;

    // Bring the earlier item into sequence too — the condition clears.
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [earlier.item_id]);

    const second = await recordSessionSummaryService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Caught up the refresh endpoint too.',
      files_touched: [],
      items_touched: [],
    });
    expect(second.drift_flags_raised).toHaveLength(0);

    const flagRow = await pool.query('SELECT resolved_at FROM drift_flags WHERE id = $1', [flagId]);
    expect(flagRow.rows[0].resolved_at).not.toBeNull();
  });

  // adversarial-review P1: hasOpenFlagForItem + insertDriftFlag was a
  // check-then-insert with no DB constraint behind it — two concurrent
  // scans of the same out-of-sequence item could both observe "not open
  // yet" and both insert. The fix backs it with a partial unique index
  // (migrations/003) and an atomic ON CONFLICT DO NOTHING insert, so this
  // holds deterministically regardless of timing, not just "usually".
  it('negative: concurrent scans of the same out-of-sequence item never raise more than one open flag', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Earlier, still pending',
      sequence_position: 1,
      depends_on: [],
    });
    const later = await createItemService(pool, config, {
      project_id: projectId,
      track_id: trackId,
      title: 'Later, finished early',
      sequence_position: 2,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [later.item_id]);

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        recordSessionSummaryService(pool, config, {
          project_id: projectId,
          track_id: trackId,
          summary_text: `Concurrent summary ${i}`,
          files_touched: [],
          items_touched: [],
        }),
      ),
    );

    const openFlags = await pool.query(
      `SELECT id FROM drift_flags WHERE item_id = $1 AND kind = 'out_of_sequence' AND resolved_at IS NULL`,
      [later.item_id],
    );
    expect(openFlags.rowCount).toBe(1);
  });

  it('negative: 404 when track does not exist in project', async () => {
    const { projectId } = await makeProjectAndTrack();
    await expect(
      recordSessionSummaryService(pool, config, {
        project_id: projectId,
        track_id: UNKNOWN_UUID,
        summary_text: 'x',
        files_touched: [],
        items_touched: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // adversarial-review reliability-4 / P1: findSequenceSkips is O(n^2) in
  // the track's item count and KNOTRACK_DRIFT_SCAN_ITEM_CAP bounds it, but
  // is documented (TRD §6.3/§7) as a kt_check_drift-scan limit, not a
  // reason to refuse an otherwise-valid kt_record_session_summary write.
  // Past the cap, the event must still commit — only the scoped drift
  // re-check is skipped. Uses a tiny cap override rather than the real
  // 5000-item default so the test stays fast.
  it('positive: the event still commits when the track has more items than driftScanItemCap allows, drift re-check skipped', async () => {
    const cappedConfig = { ...config, driftScanItemCap: 3 };
    const { projectId, trackId } = await makeProjectAndTrack();
    for (let i = 0; i < 4; i += 1) {
      await createItemService(pool, cappedConfig, {
        project_id: projectId,
        track_id: trackId,
        title: `Item ${i}`,
        sequence_position: undefined,
        depends_on: [],
      });
    }

    const result = await recordSessionSummaryService(pool, cappedConfig, {
      project_id: projectId,
      track_id: trackId,
      summary_text: 'Too many items in this track.',
      files_touched: [],
      items_touched: [],
    });

    expect(result.event_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.drift_flags_raised).toEqual([]);
    const row = await pool.query('SELECT id FROM events WHERE id = $1', [result.event_id]);
    expect(row.rowCount).toBe(1);
  });

  // adversarial-review test_quality-1 (docs/ROADMAP.md T9.x): the wrong-track
  // 422 path above was covered, but the earlier, distinct 404 path — an
  // items_touched id that isn't a real item at all — never had its own test.
  it('negative: 404 when an items_touched id does not exist as an item at all', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();

    await expect(
      recordSessionSummaryService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        summary_text: 'x',
        files_touched: [],
        items_touched: [UNKNOWN_UUID],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative: 422 when an items_touched id belongs to a different track', async () => {
    const { projectId, trackId } = await makeProjectAndTrack();
    const otherTrack = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Other track',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const itemElsewhere = await createItemService(pool, config, {
      project_id: projectId,
      track_id: otherTrack.track_id,
      title: 'Elsewhere',
      sequence_position: undefined,
      depends_on: [],
    });

    await expect(
      recordSessionSummaryService(pool, config, {
        project_id: projectId,
        track_id: trackId,
        summary_text: 'x',
        files_touched: [],
        items_touched: [itemElsewhere.item_id],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
