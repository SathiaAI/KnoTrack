import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { syncToGithubService, type SyncToGithubDeps } from '../../src/mcp/tools/sync-to-github.js';
import { getTrackService } from '../../src/mcp/tools/get-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { updateItemStatusService } from '../../src/mcp/tools/update-item-status.js';
import { upsertAdapter } from '../../src/db/queries/adapters.js';
import { encryptCredential } from '../../src/crypto/credential-cipher.js';
import type { GitHubClient, GitHubIssueRef, GitHubResult } from '../../src/github/github-client.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();
const REPO = 'SathiaAI/KnoTrack';

// ---- fake GitHub client -----------------------------------------------
interface FakeState {
  createCalls: Array<{ repo: string; payload: { state: string } }>;
  updateCalls: Array<{ repo: string; number: string; payload: { state: string } }>;
  findCalls: Array<{ repo: string; marker: string }>;
  nextNumber: number;
}
interface FakeOverrides {
  createIssue?: (s: FakeState) => GitHubResult<GitHubIssueRef>;
  updateIssue?: (s: FakeState, num: string) => GitHubResult<GitHubIssueRef>;
  findIssueByMarker?: (s: FakeState) => GitHubResult<GitHubIssueRef | null>;
}
function makeFake(overrides: FakeOverrides = {}) {
  const state: FakeState = { createCalls: [], updateCalls: [], findCalls: [], nextNumber: 1 };
  const client: GitHubClient = {
    createIssue(repo, payload) {
      state.createCalls.push({ repo, payload });
      const r: GitHubResult<GitHubIssueRef> = overrides.createIssue
        ? overrides.createIssue(state)
        : {
            ok: true,
            value: {
              number: String(state.nextNumber++),
              html_url: `https://github.com/${repo}/issues/${state.nextNumber - 1}`,
            },
          };
      return Promise.resolve(r);
    },
    updateIssue(repo, number, payload) {
      state.updateCalls.push({ repo, number, payload });
      const r: GitHubResult<GitHubIssueRef> = overrides.updateIssue
        ? overrides.updateIssue(state, number)
        : { ok: true, value: { number, html_url: `https://github.com/${repo}/issues/${number}` } };
      return Promise.resolve(r);
    },
    findIssueByMarker(repo, marker) {
      state.findCalls.push({ repo, marker });
      const r: GitHubResult<GitHubIssueRef | null> = overrides.findIssueByMarker
        ? overrides.findIssueByMarker(state)
        : { ok: true, value: null };
      return Promise.resolve(r);
    },
  };
  const deps: SyncToGithubDeps = { githubClientFactory: () => client };
  return { state, deps };
}

async function makeProjectTrack(opts: { repo?: string | undefined; withGithub?: boolean } = {}) {
  const withGithub = opts.withGithub ?? true;
  const adapters = withGithub
    ? { github: { personal_access_token: 'ghp_test_secret', repo: opts.repo } }
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

async function linkRow(trackId: string) {
  const r = await pool.query(
    `SELECT * FROM track_external_links WHERE track_id = $1 AND adapter_type = 'github'`,
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

describe('kt_sync_to_github — preconditions (PRD §4.13)', () => {
  it('CONFLICT (github-specific) when no github adapter is configured, even with a linear one (GHSY-03)', async () => {
    const { project_id, track_id } = await makeProjectTrack({ withGithub: false });
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

  it('CONFLICT when the github adapter has no repository configured', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: undefined });
    await expect(syncToGithubService(pool, config, { project_id, track_id })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        message: 'github adapter has no repository configured',
      },
    );
  });

  it('404 when the project does not exist', async () => {
    const { track_id } = await makeProjectTrack({ repo: REPO });
    await expect(
      syncToGithubService(pool, config, { project_id: UNKNOWN_UUID, track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404 when the track belongs to another project (no cross-project leak)', async () => {
    const other = await makeProjectTrack({ repo: REPO });
    const { project_id } = await makeProjectTrack({ repo: REPO });
    await expect(
      syncToGithubService(pool, config, { project_id, track_id: other.track_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('kt_sync_to_github — create / update / no-op', () => {
  it('creates an issue, links it, and surfaces the URL on kt_get_track', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const { state, deps } = makeFake();

    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls).toHaveLength(1);

    const row = await linkRow(track_id);
    expect(row?.sync_state).toBe('linked');
    expect(row?.external_id).toBe('1');

    const track = await getTrackService(pool, config, { project_id, track_id });
    expect(track.track.github_issue_url).toBe(`https://github.com/${REPO}/issues/1`);

    // a successful sync stamps the watermark (T5.2; SYNC_DRIFT input)
    const wm = await pool.query(`SELECT last_github_sync_at FROM tracks WHERE id = $1`, [track_id]);
    expect(wm.rows[0].last_github_sync_at).not.toBeNull();
  });

  it('is a no-op on an unchanged re-sync (no second HTTP call)', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const { state, deps } = makeFake();
    await syncToGithubService(pool, config, { project_id, track_id }, deps);
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls).toHaveLength(1);
    expect(state.updateCalls).toHaveLength(0);
  });

  it('updates the existing issue when the track content changes', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const { state, deps } = makeFake();
    await syncToGithubService(pool, config, { project_id, track_id }, deps);
    // change content -> hash differs -> PATCH
    await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'New item',
      sequence_position: undefined,
      depends_on: [],
    });
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls).toHaveLength(1);
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]!.number).toBe('1');
  });

  it('closes the issue for a done track (create then close PATCH)', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
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
    const { state, deps } = makeFake();
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.createCalls).toHaveLength(1);
    // a done track closes the freshly-created (open) issue via a follow-up PATCH
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]!.payload.state).toBe('closed');
  });
});

describe('kt_sync_to_github — operational failures ({ok:false}, never throw)', () => {
  it('passes through a definitive failure and clears the pending claim', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const { deps } = makeFake({
      createIssue: () => ({ ok: false, error: 'GITHUB_RATE_LIMITED: slow down', ambiguous: false }),
    });
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/^GITHUB_RATE_LIMITED/);
    // definitive failure -> no issue created -> pending row cleared
    expect(await linkRow(track_id)).toBeUndefined();
  });

  it('keeps the pending claim after an ambiguous (timeout) failure', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const { deps } = makeFake({
      createIssue: () => ({ ok: false, error: 'GITHUB_TIMEOUT: too slow', ambiguous: true }),
    });
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/^GITHUB_TIMEOUT/);
    const row = await linkRow(track_id);
    expect(row?.sync_state).toBe('pending');
  });

  it('returns {ok:false, GITHUB_NOT_FOUND} on a 404 update and does NOT recreate', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const first = makeFake();
    await syncToGithubService(pool, config, { project_id, track_id }, first.deps);
    // change content so an update is attempted
    await createItemService(pool, config, {
      project_id,
      track_id,
      title: 'x',
      sequence_position: undefined,
      depends_on: [],
    });
    const { state, deps } = makeFake({
      updateIssue: () => ({ ok: false, error: 'GITHUB_NOT_FOUND: gone', ambiguous: false }),
    });
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/^GITHUB_NOT_FOUND/);
    expect(state.createCalls).toHaveLength(0); // no auto-recreate
    expect((await linkRow(track_id))?.sync_state).toBe('linked'); // link unchanged
  });

  it('refuses to update when the adapter repo changed under an existing link', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const first = makeFake();
    await syncToGithubService(pool, config, { project_id, track_id }, first.deps);
    // repoint the adapter at a different repo (keep a decryptable credential —
    // the handler decrypts before it reaches the repo-changed refusal)
    await upsertAdapter(pool, {
      projectId: project_id,
      type: 'github',
      encryptedCredential: encryptCredential('ghp_test_secret', config.encryptionKey),
      config: { repo: 'SathiaAI/Other' },
    });
    const { state, deps } = makeFake();
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/refusing to update a different repository/);
    expect(state.updateCalls).toHaveLength(0);
    expect(state.createCalls).toHaveLength(0);
  });
});

describe('kt_sync_to_github — durable creation-intent / recovery', () => {
  it('concurrent syncs create exactly one issue (no duplicate)', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    const { state, deps } = makeFake();
    const [a, b] = await Promise.all([
      syncToGithubService(pool, config, { project_id, track_id }, deps),
      syncToGithubService(pool, config, { project_id, track_id }, deps),
    ]);
    expect(state.createCalls).toHaveLength(1);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM track_external_links WHERE track_id = $1 AND adapter_type='github'`,
      [track_id],
    );
    expect(rows.rows[0].n).toBe(1);
    // at least one call succeeded; neither threw
    expect([a.ok, b.ok]).toContain(true);
  });

  it('recovers a crashed pending link by adopting the issue the marker finds', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    // simulate a crash after the pending claim was committed but before finalize
    await pool.query(
      `INSERT INTO track_external_links (track_id, adapter_type, sync_state, repo_identity, operation_id)
       VALUES ($1, 'github', 'pending', $2, $3)`,
      [track_id, REPO, randomUUID()],
    );
    const { state, deps } = makeFake({
      findIssueByMarker: () => ({
        ok: true,
        value: { number: '42', html_url: `https://github.com/${REPO}/issues/42` },
      }),
    });
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res).toEqual({ ok: true });
    expect(state.findCalls).toHaveLength(1);
    expect(state.createCalls).toHaveLength(0); // adopted, not recreated
    const row = await linkRow(track_id);
    expect(row?.sync_state).toBe('linked');
    expect(row?.external_id).toBe('42');
  });

  it('never recreates on a marker miss — surfaces the pending link for resolution (no duplicate)', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    // even an old pending row is not recreated: a Search miss cannot prove the
    // earlier (ambiguous) create did not land, so we refuse rather than risk a
    // duplicate (T5.2: duplicate prevention over auto-retry).
    await pool.query(
      `INSERT INTO track_external_links (track_id, adapter_type, sync_state, repo_identity, operation_id, created_at)
       VALUES ($1, 'github', 'pending', $2, $3, now() - interval '2 hours')`,
      [track_id, REPO, randomUUID()],
    );
    const { state, deps } = makeFake(); // findIssueByMarker default -> null
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/not auto-recreated/);
    expect(state.findCalls).toHaveLength(1);
    expect(state.createCalls).toHaveLength(0); // NEVER recreate on a miss
    expect((await linkRow(track_id))?.sync_state).toBe('pending');
  });

  it('refuses recovery when the adapter repo changed while a sync was pending (no wrong-repo search/recreate)', async () => {
    const { project_id, track_id } = await makeProjectTrack({ repo: REPO });
    // pending row bound to a DIFFERENT repo than the adapter now points at
    await pool.query(
      `INSERT INTO track_external_links (track_id, adapter_type, sync_state, repo_identity, operation_id, created_at)
       VALUES ($1, 'github', 'pending', 'SathiaAI/OldRepo', $2, now() - interval '5 minutes')`,
      [track_id, randomUUID()],
    );
    const { state, deps } = makeFake();
    const res = await syncToGithubService(pool, config, { project_id, track_id }, deps);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/resolve the repository change/);
    expect(state.findCalls).toHaveLength(0); // never searched the wrong repo
    expect(state.createCalls).toHaveLength(0);
    expect((await linkRow(track_id))?.sync_state).toBe('pending');
  });
});
