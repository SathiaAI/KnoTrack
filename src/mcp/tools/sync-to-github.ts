// kt_sync_to_github — docs/PRD.md §4.13, docs/ROADMAP.md T5.2.
//
// Syncs ONE track (not an item — §4.13: "no item-level sync target in v1")
// to a GitHub Issue, idempotently. The authoritative create-vs-update key
// is a track_external_links row, never a GitHub search (design panel
// 2026-09-19, unanimous Option A). Idempotency is hardened with a durable
// creation-intent: a `pending` link is committed BEFORE the outbound POST,
// so a crash between GitHub accepting a create and this server finalizing
// the link never silently produces a duplicate — the next call sees
// `pending` and recovers via the hidden body marker instead of blindly
// re-creating.
//
// Failure surfaces, per §4.13:
//   - Missing/unusable adapter precondition -> CONFLICT (a thrown KtError).
//   - Everything about actually talking to GitHub -> a SUCCESSFUL tool call
//     returning { ok: false, error: "<PREFIX>: ..." } with a fixed prefix
//     (GITHUB_AUTH_FAILED / GITHUB_NOT_FOUND / GITHUB_RATE_LIMITED /
//     GITHUB_TIMEOUT / GITHUB_UNKNOWN_ERROR).
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { syncToGithubInputSchema, type SyncToGithubInput } from '../../schemas/tools.js';
import { runTool } from '../tool-helpers.js';
import { conflict, notFound } from '../errors.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById, touchGithubSyncWatermark } from '../../db/queries/tracks.js';
import { listItemsByTrack } from '../../db/queries/items.js';
import { getAdapterForProject } from '../../db/queries/adapters.js';
import { decryptCredential } from '../../crypto/credential-cipher.js';
import { buildIssuePayload, payloadContentHash, trackMarker } from './issue-payload.js';
import { withReadSnapshot, withTransaction } from '../../db/tx.js';
import {
  claimPendingLink,
  clearPendingLink,
  finalizeLinked,
  getLinkForUpdate,
  updateLinkedContentHash,
  type TrackExternalLinkRow,
} from '../../db/queries/track-external-links.js';
import {
  createFetchGitHubClient,
  type GitHubClient,
  type GitHubClientFactory,
  type GitHubIssuePayload,
} from '../../github/github-client.js';

const ADAPTER = 'github' as const;
const USER_AGENT = 'knotrack-mcp-server';

export interface GithubSyncOutput extends Record<string, unknown> {
  ok: boolean;
  error?: string;
}

export interface SyncToGithubDeps {
  githubClientFactory?: GitHubClientFactory;
}

export async function syncToGithubService(
  pool: Pool,
  config: Config,
  input: SyncToGithubInput,
  deps: SyncToGithubDeps = {},
): Promise<GithubSyncOutput> {
  const clientFactory = deps.githubClientFactory ?? createFetchGitHubClient;

  // 1. Project + project-scoped track existence (a track_id from another
  //    project is a 404, never a cross-project leak).
  const project = await findActiveProjectById(pool, input.project_id);
  if (!project) {
    throw notFound('project not found', { project_id: input.project_id });
  }
  const track = await findTrackById(pool, input.project_id, input.track_id);
  if (!track) {
    throw notFound('track not found', {
      project_id: input.project_id,
      track_id: input.track_id,
    });
  }

  // 2. Adapter precondition -> CONFLICT (no HTTP). §4.13.
  const adapter = await getAdapterForProject(pool, input.project_id, ADAPTER);
  if (!adapter) {
    throw conflict('github adapter not configured', {
      project_id: input.project_id,
      adapter: ADAPTER,
    });
  }
  const repoRaw = adapter.config['repo'];
  const repo = typeof repoRaw === 'string' ? repoRaw.trim() : '';
  if (!repo) {
    // An adapter with no target repo can't form an API URL; it's a
    // configuration precondition the caller fixes by re-registering with a
    // repo, so it's a CONFLICT — not a false GitHub call.
    throw conflict('github adapter has no repository configured', {
      project_id: input.project_id,
      adapter: ADAPTER,
    });
  }

  // 3. Decrypt the stored credential (a failure here is unexpected and
  //    surfaces as INTERNAL_ERROR via runTool — never leaks the token).
  const token = decryptCredential(adapter.encrypted_credential, config.encryptionKey);

  // 4. Deterministic payload + no-op hash. Read the track and its items in
  //    ONE consistent snapshot so the rendered payload (and its hash) can't
  //    mix a pre- and post-change view if items change mid-call.
  const snap = await withReadSnapshot(pool, async (c) => {
    // now() inside a REPEATABLE READ transaction is the snapshot boundary —
    // the exact "as of" time of the state we are about to push.
    const asOf = (await c.query<{ t: Date }>('SELECT now() AS t')).rows[0]!.t;
    const t = await findTrackById(c, input.project_id, input.track_id);
    return { asOf, track: t, items: t ? await listItemsByTrack(c, t.id) : [] };
  });
  if (!snap.track) {
    // Track deleted between the existence check and here — treat as not found.
    throw notFound('track not found', {
      project_id: input.project_id,
      track_id: input.track_id,
    });
  }
  const syncedAt = snap.asOf;
  const payload = buildIssuePayload(
    { id: snap.track.id, title: snap.track.title, status: snap.track.status },
    snap.items.map((i) => ({
      title: i.title,
      status: i.status,
      sequence_position: i.sequence_position,
    })),
  );
  const hash = payloadContentHash(payload);

  const client = clientFactory(token, {
    timeoutMs: config.githubSyncTimeoutMs,
    userAgent: USER_AGENT,
  });

  // 5. Decide under a row lock; claim a fresh pending slot if none exists.
  //    This transaction commits before any POST, so a create's durable
  //    intent survives a crash.
  const decision = await withTransaction(pool, async (c): Promise<Decision> => {
    const existing = await getLinkForUpdate(c, track.id, ADAPTER);
    if (existing) {
      if (existing.sync_state === 'pending') return { kind: 'pending', row: existing };
      if (existing.repo_identity !== repo) return { kind: 'repo_changed', row: existing };
      if (existing.content_hash === hash) return { kind: 'noop' };
      return { kind: 'update', row: existing };
    }
    const operationId = randomUUID();
    const claimed = await claimPendingLink(c, {
      trackId: track.id,
      adapterType: ADAPTER,
      repoIdentity: repo,
      operationId,
    });
    if (claimed) return { kind: 'create', operationId };
    return { kind: 'raced' };
  });

  switch (decision.kind) {
    case 'noop':
      // Nothing to push, but we confirmed the issue is in sync -> watermark.
      return okSynced(pool, track.id, syncedAt);
    case 'repo_changed':
      return {
        ok: false,
        error: `GITHUB_UNKNOWN_ERROR: this track is linked to an issue in ${decision.row.repo_identity}, but the adapter is now configured for ${repo}; refusing to update a different repository`,
      };
    case 'raced':
      return {
        ok: false,
        error: 'GITHUB_UNKNOWN_ERROR: another sync for this track is in progress; retry shortly',
      };
    case 'update':
      return updateExisting(pool, client, repo, track.id, decision.row, payload, hash, syncedAt);
    case 'create':
      return createFresh(
        pool,
        client,
        repo,
        track.id,
        decision.operationId,
        payload,
        hash,
        syncedAt,
      );
    case 'pending':
      return recoverPending(pool, client, repo, track.id, decision.row, payload, hash, syncedAt);
  }
}

/** Records the sync watermark (to the payload snapshot time) and returns
 * success. Called on every ok:true path (create, update, no-op, adopt) so
 * tracks.last_github_sync_at reflects the state actually pushed (T5.2;
 * SYNC_DRIFT input for T6). */
async function okSynced(pool: Pool, trackId: string, syncedAt: Date): Promise<GithubSyncOutput> {
  await withTransaction(pool, (c) => touchGithubSyncWatermark(c, trackId, syncedAt));
  return { ok: true };
}

type Decision =
  | { kind: 'noop' }
  | { kind: 'repo_changed'; row: TrackExternalLinkRow }
  | { kind: 'raced' }
  | { kind: 'update'; row: TrackExternalLinkRow }
  | { kind: 'create'; operationId: string }
  | { kind: 'pending'; row: TrackExternalLinkRow };

async function createFresh(
  pool: Pool,
  client: GitHubClient,
  repo: string,
  trackId: string,
  operationId: string,
  payload: GitHubIssuePayload,
  hash: string,
  syncedAt: Date,
): Promise<GithubSyncOutput> {
  const created = await client.createIssue(repo, payload);
  if (!created.ok) {
    if (!created.ambiguous) {
      // Definitive rejection -> no issue was created; clear the pending
      // claim so the next attempt starts clean instead of wedging.
      await withTransaction(pool, (c) =>
        clearPendingLink(c, { trackId, adapterType: ADAPTER, operationId }),
      );
    }
    return { ok: false, error: created.error };
  }
  let ref = created.value;
  if (payload.state === 'closed') {
    // Create makes an open issue; a done track needs a follow-up close. If
    // it fails, the issue exists but the link stays pending — recovery will
    // adopt and reconcile it next time (never a duplicate).
    const closed = await client.updateIssue(repo, ref.number, payload);
    if (!closed.ok) return { ok: false, error: closed.error };
    ref = closed.value;
  }
  const finalized = await withTransaction(pool, (c) =>
    finalizeLinked(c, {
      trackId,
      adapterType: ADAPTER,
      operationId,
      externalId: ref.number,
      externalUrl: ref.html_url,
      contentHash: hash,
    }),
  );
  if (!finalized) {
    return {
      ok: false,
      error:
        'GITHUB_UNKNOWN_ERROR: issue created but its link could not be finalized; reconcile manually',
    };
  }
  return okSynced(pool, trackId, syncedAt);
}

async function updateExisting(
  pool: Pool,
  client: GitHubClient,
  repo: string,
  trackId: string,
  row: TrackExternalLinkRow,
  payload: GitHubIssuePayload,
  hash: string,
  syncedAt: Date,
): Promise<GithubSyncOutput> {
  // row is linked -> external_id is the issue number.
  const issueNumber = row.external_id;
  if (!issueNumber) {
    return {
      ok: false,
      error: 'GITHUB_UNKNOWN_ERROR: linked row is missing its issue number; reconcile manually',
    };
  }
  const res = await client.updateIssue(repo, issueNumber, payload);
  if (!res.ok) {
    // A 404 here means the linked issue was deleted/transferred: return the
    // operational error and do NOT auto-recreate in T5.2 (would risk a
    // duplicate); a later relink tool can handle re-creation deliberately.
    return { ok: false, error: res.error };
  }
  await withTransaction(pool, (c) =>
    updateLinkedContentHash(c, { trackId, adapterType: ADAPTER, contentHash: hash }),
  );
  return okSynced(pool, trackId, syncedAt);
}

async function recoverPending(
  pool: Pool,
  client: GitHubClient,
  repo: string,
  trackId: string,
  row: TrackExternalLinkRow,
  payload: GitHubIssuePayload,
  hash: string,
  syncedAt: Date,
): Promise<GithubSyncOutput> {
  // If the adapter's repo changed while this sync was pending, the marker
  // would be searched in (and any recreate would land in) the wrong repo.
  // Refuse until the repository change is resolved.
  if (row.repo_identity !== repo) {
    return {
      ok: false,
      error: `GITHUB_UNKNOWN_ERROR: a sync is pending for this track against ${row.repo_identity}, but the adapter is now configured for ${repo}; resolve the repository change before retrying`,
    };
  }
  const found = await client.findIssueByMarker(repo, trackMarker(trackId));
  if (!found.ok) {
    // Couldn't even run the recovery search -> stay pending, ask to retry.
    return { ok: false, error: found.error };
  }
  if (found.value) {
    // The earlier create DID happen. Reconcile the found issue to current
    // content (this also confirms it still exists), then adopt it as linked.
    const ref = found.value;
    const res = await client.updateIssue(repo, ref.number, payload);
    if (!res.ok) return { ok: false, error: res.error };
    const finalized = await withTransaction(pool, (c) =>
      finalizeLinked(c, {
        trackId,
        adapterType: ADAPTER,
        operationId: row.operation_id,
        externalId: res.value.number,
        externalUrl: res.value.html_url,
        contentHash: hash,
      }),
    );
    if (!finalized) {
      return {
        ok: false,
        error: 'GITHUB_UNKNOWN_ERROR: adopted issue could not be finalized; reconcile manually',
      };
    }
    return okSynced(pool, trackId, syncedAt);
  }

  // Marker not found. A pending link only survives an AMBIGUOUS create
  // (definitive failures clear it in createFresh), so the create outcome is
  // unknown by construction here. A GitHub Search miss — even a complete one
  // — does NOT prove no issue was created: search indexing is eventually
  // consistent and can lag arbitrarily. Per the T5.2 design decision
  // (Paul, 2026-09-19: duplicate prevention takes priority over automatic
  // retry when the outcome cannot be established), we do NOT auto-recreate.
  // Recovery only ever adopts an issue the marker positively finds; an
  // unresolved pending link is surfaced for explicit resolution (an operator
  // clears it, or a future relink tool) rather than risking a duplicate.
  return {
    ok: false,
    error:
      'GITHUB_UNKNOWN_ERROR: a previous sync did not complete and no matching issue could be found; its outcome cannot be safely confirmed, so this track is not auto-recreated (that would risk a duplicate). Clear the pending link (or use a relink tool) to resync.',
  };
}

export function registerSyncToGithubTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_sync_to_github',
    {
      title: 'Sync to GitHub',
      description:
        'Creates or updates a GitHub Issue for a track (idempotent). Requires a configured GitHub adapter with a repository; operational GitHub failures return { ok: false, error } rather than throwing.',
      inputSchema: syncToGithubInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = syncToGithubInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_sync_to_github', () => syncToGithubService(pool, config, input));
    },
  );
}
