import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getProjectStatusService } from '../../src/mcp/tools/get-project-status.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { recordSessionSummaryService } from '../../src/mcp/tools/record-session-summary.js';
import { withReadSnapshot } from '../../src/db/tx.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_get_project_status', () => {
  it('positive: rolls up tracks with item counts and recent events', async () => {
    const { project_id } = await registerProjectService(pool, config, {
      name: 'P',
      source_type: 'local',
      source_ref: `/tmp/${crypto.randomUUID()}`,
      adapters: undefined,
    });
    const { track_id } = await createTrackService(pool, config, {
      project_id,
      title: 'Auth overhaul',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const item1 = await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'Item 1',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [item1.item_id]);
    await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'Item 2',
      sequence_position: undefined,
      depends_on: [],
    });
    await recordSessionSummaryService(pool, config, {
      project_id,
      track_id,
      summary_text: 'Wired up JWT refresh flow.',
      files_touched: [],
      items_touched: [],
    });

    const status = await getProjectStatusService(pool, config, { project_id });

    expect(status.tracks).toHaveLength(1);
    expect(status.tracks[0]).toMatchObject({
      track_id,
      title: 'Auth overhaul',
      status: 'on_track',
      item_counts: { pending: 1, in_progress: 0, done: 1, blocked: 0 },
    });
    expect(status.recent_events).toHaveLength(1);
    expect(status.recent_events[0]).toMatchObject({
      event_type: 'session_summary',
      track_id,
      summary_text: 'Wired up JWT refresh flow.',
    });
    expect(status.drift_flags).toEqual([]);
  });

  // adversarial-review test_quality-4 (docs/ROADMAP.md T9.x): the positive
  // roll-up test above only ever asserted `drift_flags: []` — no test
  // verified the field mapping (flag_id/flag_type/severity/track_id/
  // item_id/detail/status/raised_at) when an open flag actually exists.
  it('positive: drift_flags reflects an actually-open flag with every field mapped', async () => {
    const { project_id } = await registerProjectService(pool, config, {
      name: 'P',
      source_type: 'local',
      source_ref: `/tmp/${crypto.randomUUID()}`,
      adapters: undefined,
    });
    const { track_id } = await createTrackService(pool, config, {
      project_id,
      title: 'Track with drift',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'Earlier, still pending',
      sequence_position: 1,
      depends_on: [],
    });
    const later = await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'Later, finished early',
      sequence_position: 2,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [later.item_id]);

    const summary = await recordSessionSummaryService(pool, config, {
      project_id,
      track_id,
      summary_text: 'Finished the later item out of sequence.',
      files_touched: [],
      items_touched: [],
    });
    expect(summary.drift_flags_raised).toHaveLength(1);

    const status = await getProjectStatusService(pool, config, { project_id });

    expect(status.drift_flags).toHaveLength(1);
    const flag = status.drift_flags[0];
    expect(flag).toMatchObject({
      flag_type: 'SEQUENCE_SKIP',
      severity: expect.any(String),
      track_id,
      item_id: later.item_id,
      status: 'open',
    });
    expect(flag?.flag_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(typeof flag?.detail).toBe('string');
    expect(flag?.detail.length).toBeGreaterThan(0);
    // raised_at must be an ISO-8601 string (per getProjectStatusService's
    // `.toISOString()` mapping), not a raw Date/driver value.
    expect(() => new Date(flag?.raised_at ?? '')).not.toThrow();
    expect(new Date(flag?.raised_at ?? '').toISOString()).toBe(flag?.raised_at);
  });

  it('negative: 404 when project does not exist', async () => {
    await expect(
      getProjectStatusService(pool, config, { project_id: UNKNOWN_UUID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // adversarial-review P2: the three roll-up queries used to run on
  // separate pool connections/snapshots, so a concurrent commit landing
  // mid-flight could mix pre- and post-commit state. The fix
  // (withReadSnapshot: one client, one REPEATABLE READ transaction) is
  // exercised directly here against a genuine concurrent commit, proving
  // the actual mechanism kt_get_project_status now relies on — a
  // timing-based test against the full service call couldn't force the
  // interleaving deterministically.
  it('positive: withReadSnapshot holds one consistent view across a concurrent commit mid-transaction', async () => {
    const { project_id } = await registerProjectService(pool, config, {
      name: 'P',
      source_type: 'local',
      source_ref: `/tmp/${crypto.randomUUID()}`,
      adapters: undefined,
    });
    await createTrackService(pool, config, {
      project_id,
      title: 'Track A',
      depends_on: [],
      source_doc_ref: undefined,
    });

    let countBeforeConcurrentCommit = -1;
    let countAfterConcurrentCommit = -1;
    await withReadSnapshot(pool, async (client) => {
      const before = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tracks WHERE project_id = $1',
        [project_id],
      );
      countBeforeConcurrentCommit = before.rows[0]?.n ?? -1;

      // A fully separate connection commits a second track after this
      // snapshot was already established.
      await createTrackService(pool, config, {
        project_id,
        title: 'Track B (concurrent)',
        depends_on: [],
        source_doc_ref: undefined,
      });

      const after = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tracks WHERE project_id = $1',
        [project_id],
      );
      countAfterConcurrentCommit = after.rows[0]?.n ?? -1;
    });

    expect(countBeforeConcurrentCommit).toBe(1);
    // Without REPEATABLE READ, this second read on the same transaction
    // would already see the concurrently committed second track — exactly
    // the torn-snapshot behavior the fix prevents.
    expect(countAfterConcurrentCommit).toBe(1);

    const finalCount = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM tracks WHERE project_id = $1',
      [project_id],
    );
    expect(finalCount.rows[0]?.n).toBe(2);
  });
});
