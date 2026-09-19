import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { syncToLinearService, type SyncToLinearDeps } from '../../src/mcp/tools/sync-to-linear.js';
import { getTrackService } from '../../src/mcp/tools/get-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { updateItemStatusService } from '../../src/mcp/tools/update-item-status.js';
import { upsertAdapter } from '../../src/db/queries/adapters.js';
import { encryptCredential } from '../../src/crypto/credential-cipher.js';
import type {
  LinearClient,
  LinearIssuePayload,
  LinearIssueRef,
  LinearResult,
  LinearWorkflowState,
} from '../../src/linear/linear-client.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();
const TEAM = 'team-1';

const DEFAULT_STATES: LinearWorkflowState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's-doing', name: 'Doing', type: 'started', position: 2 },
  { id: 's-done', name: 'Done', type: 'completed', position: 3 },
  { id: 's-released', name: 'Released', type: 'completed', position: 5 },
  { id: 's-cancel', name: 'Cancelled', type: 'canceled', position: 6 },
];

// ---- fake Linear client ------------------------------------------------
interface FakeState {
  createCalls: Array<{ teamId: string; stateId?: string; payload: LinearIssuePayload }>;
  updateCalls: Array<{ issueId: string; stateId?: string }>;
  findCalls: Array<{ teamId: string; marker: string }>;
  statesCalls: number;
  nextId: number;
}
interface FakeOverrides {
  createIssue?: (s: FakeState) => LinearResult<LinearIssueRef>;
  updateIssue?: (s: FakeState, issueId: string) => LinearResult<LinearIssueRef>;
  findIssueByMarker?: (s: FakeState) => LinearResult<LinearIssueRef | null>;
  getWorkflowStates?: () => LinearResult<LinearWorkflowState[]>;
  getIssueStateType?: () => LinearResult<string | null>;
}
function makeFake(overrides: FakeOverrides = {}) {
  const state: FakeState = {
    createCalls: [],
    updateCalls: [],
    findCalls: [],
    statesCalls: 0,
    nextId: 1,
  };
  const client: LinearClient = {
    createIssue(teamId, payload, stateId) {
      state.createCalls.push({ teamId, stateId, payload });
      const r: LinearResult<LinearIssueRef> = overrides.createIssue
        ? overrides.createIssue(state)
        : {
            ok: true,
            value: {
              id: `iss-${state.nextId++}`,
              identifier: `ENG-${state.nextId - 1}`,
              url: `https://linear.app/x/issue/ENG-${state.nextId - 1}`,
            },
          };
      return Promise.resolve(r);
    },
    updateIssue(issueId, _payload, stateId) {
      state.updateCalls.push({ issueId, stateId });
      const r: LinearResult<LinearIssueRef> = overrides.updateIssue
        ? overrides.updateIssue(state, issueId)
        : {
            ok: true,
            value: {
              id: issueId,
              identifier: 'ENG-1',
              url: `https://linear.app/x/issue/${issueId}`,
            },
          };
      return Promise.resolve(r);
    },
    findIssueByMarker(teamId, marker) {
      state.findCalls.push({ teamId, marker });
      const r: LinearResult<LinearIssueRef | null> = overrides.findIssueByMarker
        ? overrides.findIssueByMarker(state)
        : { ok: true, value: null };
      return Promise.resolve(r);
    },
    getWorkflowStates() {
      state.statesCalls += 1;
      const r: LinearResult<LinearWorkflowState[]> = overrides.getWorkflowStates
        ? overrides.getWorkflowStates()
        : { ok: true, value: DEFAULT_STATES };
      return Promise.resolve(r);
    },
    getIssueStateType() {
      const r: LinearResult<string | null> = overrides.getIssueStateType
        ? overrides.getIssueStateType()
        : { ok: true, value: 'completed' };
      return Promise.resolve(r);
    },
  };
  const deps: SyncToLinearDeps = { linearClientFactory: () => client };
  return { state, deps };
}

async function makeProjectTrack(
  opts: {
    withLinear?: boolean;
    teamId?: string | null;
    doneStateId?: string;
    openStateId?: string;
  } = {},
) {
  const withLinear = opts.withLinear ?? true;
  const adapters = withLinear
    ? {
        linear: {
          api_key: 'lin_test_secret',
          team_id: opts.teamId ?? TEAM,
          done_state_id: opts.doneStateId,
          open_state_id: opts.openStateId,
        },
      }
    : undefined;
  const { project_id } = await registerProjectService(pool, config, {
    name: 'P',
    source_type: 'local',
    source_ref: `/tmp/${randomUUID()}`,
    adapters,
  });
  const { track_id } = await createTrackService(pool, config, {
    project_id,
    title: 'Auth overhaul',
    depends_on: [],
    source_doc_ref: undefined,
  });
  return { project_id, track_id };
}

async function markTrackDone(project_id: string, track_id: string) {
  const item = await createItemService(pool, config, {
    project_id,
    track_id,
    title: 'only item',
    sequence_position: undefined,
    depends_on: [],
  });
  await updateItemStatusService(pool, config, {
    project_id,
    item_id: item.item_id,
    status: 'done',
  });
}

async function linkRow(trackId: string) {
  const r = await pool.query(
    `SELECT * FROM track_external_links WHERE track_id = $1 AND adapter_type = 'linear'`,
    [trackId],
  );
  return r.rows[0] as
    { sync_state: string; external_id: string | null; external_url: string | null } | undefined;
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeTestPool();
});

describe('kt_sync_to_linear — preconditions (PRD §4.14)', () => {
  it('CONFLICT when no linear adapter is configured', async () => {
    const { project_id, track_id } = await makeProjectTrack({ withLinear: false });
    await expect(syncToLinearService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        message: 'linear adapter not configured',
        details: { adapter: 'linear' },
      },
    );
  });

  it('CONFLICT when the linear adapter has no team configured', async () => {
    const { project_id, track_id } = await makeProjectTrack({ withLinear: false });
    await upsertAdapter(pool, {
      projectId: project_id,
      type: 'linear',
      encryptedCredential: encryptCredential('lin_test_secret', config.encryptionKey),
      config: {},
    });
    await expect(syncToLinearService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        message: 'linear adapter has no team configured',
      },
    );
  });

  it('404 when the project does not exist', async () => {
    const { track_id } = await makeProjectTrack();
    await expect(
      syncToLinearService(pool, config, { project_id: UNKNOWN_UUID, track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404 when the track belongs to another project (no cross-project leak)', async () => {
    const other = await makeProjectTrack();
    const { project_id } = await makeProjectTrack();
    await expect(
      syncToLinearService(pool, config, { project_id, track_id: other.track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('kt_sync_to_linear — create / update / no-op', () => {
  it('creates an issue, links it, and surfaces the URL on kt_get_track', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    const { state, deps } = makeFake();

    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls).toHaveLength(1);
    // non-done track, no override -> no workflow-state lookup, no stateId set
    expect(state.statesCalls).toBe(0);
    expect(state.createCalls[0]!.stateId).toBeUndefined();

    const row = await linkRow(track_id);
    expect(row?.sync_state).toBe('linked');
    expect(row?.external_id).toBe('iss-1');

    const track = await getTrackService(pool, config, { project_id, track_id });
    expect(track.track.linear_issue_url).toBe('https://linear.app/x/issue/ENG-1');

    const wm = await pool.query(`SELECT last_linear_sync_at FROM tracks WHERE id = $1`, [track_id]);
    expect(wm.rows[0].last_linear_sync_at).not.toBeNull();
  });

  it('is a no-op on an unchanged re-sync (no second mutation)', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    const { state, deps } = makeFake();
    await syncToLinearService(pool, config, { project_id, track_id }, deps);
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls).toHaveLength(1);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('updates the existing issue when the track content changes', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    const { state, deps } = makeFake();
    await syncToLinearService(pool, config, { project_id, track_id }, deps);
    await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'New item',
      sequence_position: undefined,
      depends_on: [],
    });
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls).toHaveLength(1);
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]!.issueId).toBe('iss-1');
  });

  it('refreshes the stored linear_issue_url when an update returns a changed URL', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    await syncToLinearService(pool, config, { project_id, track_id }, makeFake().deps);
    // change content so an update runs, and have the update return a new URL
    await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'New item',
      sequence_position: undefined,
      depends_on: [],
    });
    const { deps } = makeFake({
      updateIssue: (_s, issueId) => ({
        ok: true,
        value: { id: issueId, identifier: 'ENG-1', url: 'https://linear.app/new-slug/issue/ENG-1' },
      }),
    });
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    const track = await getTrackService(pool, config, { project_id, track_id });
    expect(track.track.linear_issue_url).toBe('https://linear.app/new-slug/issue/ENG-1');
  });
});

describe('kt_sync_to_linear — workflow-state resolution', () => {
  it('sets the lowest-position completed state on create for a done track (auto)', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    await markTrackDone(project_id, track_id);
    const { state, deps } = makeFake();
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.statesCalls).toBeGreaterThanOrEqual(1);
    // 's-done' (position 3) beats 's-released' (position 5)
    expect(state.createCalls[0]!.stateId).toBe('s-done');
  });

  it('honors a configured done_state_id override', async () => {
    const { project_id, track_id } = await makeProjectTrack({ doneStateId: 's-released' });
    await markTrackDone(project_id, track_id);
    const { state, deps } = makeFake();
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls[0]!.stateId).toBe('s-released');
  });

  it('fails LINEAR_STATE_CONFIG when done_state_id is not a completed state (and clears pending)', async () => {
    const { project_id, track_id } = await makeProjectTrack({ doneStateId: 's-doing' });
    await markTrackDone(project_id, track_id);
    const { state, deps } = makeFake();
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/^LINEAR_STATE_CONFIG/);
    expect(state.createCalls).toHaveLength(0);
    expect(await linkRow(track_id)).toBeUndefined(); // pending cleared
  });

  it('validates an override eagerly even for a non-done track (no pending row wedged)', async () => {
    // A non-done track with a bad done_state_id must be rejected up front, not
    // silently accepted until the track later becomes done.
    const { project_id, track_id } = await makeProjectTrack({ doneStateId: 's-doing' });
    const { state, deps } = makeFake();
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/^LINEAR_STATE_CONFIG/);
    expect(state.createCalls).toHaveLength(0);
    // resolution failed BEFORE any claim -> no pending row left behind
    expect(await linkRow(track_id)).toBeUndefined();
  });

  it('fails LINEAR_STATE_CONFIG when the team has no completed state', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    await markTrackDone(project_id, track_id);
    const { deps } = makeFake({
      getWorkflowStates: () => ({
        ok: true,
        value: DEFAULT_STATES.filter((s) => s.type !== 'completed'),
      }),
    });
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/no 'completed' workflow state/);
  });
});

describe('kt_sync_to_linear — operational failures ({ok:false}, never throw)', () => {
  it('passes through a definitive failure and clears the pending claim', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    const { deps } = makeFake({
      createIssue: () => ({
        ok: false,
        error: 'LINEAR_UNKNOWN_ERROR: bad input',
        ambiguous: false,
      }),
    });
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/^LINEAR_UNKNOWN_ERROR/);
    expect(await linkRow(track_id)).toBeUndefined();
  });

  it('keeps the pending claim after an ambiguous (timeout) failure', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    const { deps } = makeFake({
      createIssue: () => ({ ok: false, error: 'LINEAR_TIMEOUT: too slow', ambiguous: true }),
    });
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/^LINEAR_TIMEOUT/);
    expect((await linkRow(track_id))?.sync_state).toBe('pending');
  });

  it('refuses to update when the adapter team changed under an existing link', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    const first = makeFake();
    await syncToLinearService(pool, config, { project_id, track_id }, first.deps);
    await upsertAdapter(pool, {
      projectId: project_id,
      type: 'linear',
      encryptedCredential: encryptCredential('lin_test_secret', config.encryptionKey),
      config: { team_id: 'team-OTHER' },
    });
    const { state, deps } = makeFake();
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/refusing to update a different team/);
    expect(state.updateCalls).toHaveLength(0);
    expect(state.createCalls).toHaveLength(0);
  });
});

describe('kt_sync_to_linear — durable creation-intent / recovery', () => {
  it('concurrent syncs create exactly one issue (no duplicate)', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    const { state, deps } = makeFake();
    const [a, b] = await Promise.all([
      syncToLinearService(pool, config, { project_id, track_id }, deps),
      syncToLinearService(pool, config, { project_id, track_id }, deps),
    ]);
    expect(state.createCalls).toHaveLength(1);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM track_external_links WHERE track_id = $1 AND adapter_type='linear'`,
      [track_id],
    );
    expect(rows.rows[0].n).toBe(1);
    expect([a.ok, b.ok]).toContain(true);
  });

  it('recovers a crashed pending link by adopting the issue the marker finds', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    await pool.query(
      `INSERT INTO track_external_links (track_id, adapter_type, sync_state, repo_identity, operation_id)
       VALUES ($1, 'linear', 'pending', $2, $3)`,
      [track_id, TEAM, randomUUID()],
    );
    const { state, deps } = makeFake({
      findIssueByMarker: () => ({
        ok: true,
        value: { id: 'iss-42', identifier: 'ENG-42', url: 'https://linear.app/x/issue/ENG-42' },
      }),
    });
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.findCalls).toHaveLength(1);
    expect(state.createCalls).toHaveLength(0); // adopted, not recreated
    const row = await linkRow(track_id);
    expect(row?.sync_state).toBe('linked');
    expect(row?.external_id).toBe('iss-42');
  });

  it('never recreates on a marker miss — surfaces the pending link (no duplicate)', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    await pool.query(
      `INSERT INTO track_external_links (track_id, adapter_type, sync_state, repo_identity, operation_id, created_at)
       VALUES ($1, 'linear', 'pending', $2, $3, now() - interval '2 hours')`,
      [track_id, TEAM, randomUUID()],
    );
    const { state, deps } = makeFake(); // findIssueByMarker default -> null
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/not auto-recreated/);
    expect(state.findCalls).toHaveLength(1);
    expect(state.createCalls).toHaveLength(0);
    expect((await linkRow(track_id))?.sync_state).toBe('pending');
  });

  it('refuses recovery when the adapter team changed while a sync was pending', async () => {
    const { project_id, track_id } = await makeProjectTrack();
    await pool.query(
      `INSERT INTO track_external_links (track_id, adapter_type, sync_state, repo_identity, operation_id, created_at)
       VALUES ($1, 'linear', 'pending', 'team-OLD', $2, now() - interval '5 minutes')`,
      [track_id, randomUUID()],
    );
    const { state, deps } = makeFake();
    const res = await syncToLinearService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/resolve the team change/);
    expect(state.findCalls).toHaveLength(0); // never searched the wrong team
    expect((await linkRow(track_id))?.sync_state).toBe('pending');
  });
});
