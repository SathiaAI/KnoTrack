// kt_sync_to_linear — docs/PRD.md §4.14, docs/ROADMAP.md T5.3.
//
// Syncs ONE track to a Linear Issue, idempotently. Deliberately a close
// mirror of sync-to-github.ts: the authoritative create-vs-update key is a
// track_external_links row (never a Linear search), idempotency is hardened
// with a durable `pending` creation-intent committed BEFORE the outbound
// mutation, and a crash recovers via the hidden body marker instead of
// blindly recreating. See that file for the shared rationale.
//
// Linear-specific (frontier panel 2026-09-19, unanimous
// auto_lookup_with_config_override):
//   - Transport is GraphQL (src/linear/linear-client.ts).
//   - `repo_identity` on the link stores the bound Linear team_id.
//   - external_id stores the Linear issue UUID (issueUpdate targets it).
//   - There is no open/closed: a done track's issue is moved to a completed
//     workflow state (configured done_state_id, or the team's lowest-position
//     'completed' state); a non-done track's issue is never auto-moved back
//     unless a valid open_state_id is configured. All in resolveLinearStateId.
//
// Failure surfaces, per §4.14:
//   - Missing/unusable adapter precondition -> CONFLICT (a thrown KtError).
//   - Everything about actually talking to Linear (and an invalid state
//     configuration) -> a SUCCESSFUL tool call returning
//     { ok: false, error: "<PREFIX>: ..." } with a fixed prefix
//     (LINEAR_AUTH_FAILED / LINEAR_NOT_FOUND / LINEAR_RATE_LIMITED /
//     LINEAR_TIMEOUT / LINEAR_STATE_CONFIG / LINEAR_UNKNOWN_ERROR).
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { syncToLinearInputSchema, type SyncToLinearInput } from '../../schemas/tools.js';
import { runTool } from '../tool-helpers.js';
import { conflict, notFound } from '../errors.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById, touchLinearSyncWatermark } from '../../db/queries/tracks.js';
import { listItemsByTrack } from '../../db/queries/items.js';
import { getAdapterForProject } from '../../db/queries/adapters.js';
import { decryptCredential } from '../../crypto/credential-cipher.js';
import { trackMarker } from './issue-payload.js';
import {
  buildLinearPayload,
  linearPayloadContentHash,
  resolveLinearStateId,
  stateIntentFor,
  type LinearPayload,
} from './linear-payload.js';
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
  createFetchLinearClient,
  type LinearClient,
  type LinearClientFactory,
} from '../../linear/linear-client.js';

const ADAPTER = 'linear' as const;
const USER_AGENT = 'knotrack-mcp-server';

export interface LinearSyncOutput extends Record<string, unknown> {
  ok: boolean;
  error?: string;
}

export interface SyncToLinearDeps {
  linearClientFactory?: LinearClientFactory;
}

interface StateConfig {
  doneStateId?: string;
  openStateId?: string;
}

export async function syncToLinearService(
  pool: Pool,
  config: Config,
  input: SyncToLinearInput,
  deps: SyncToLinearDeps = {},
): Promise<LinearSyncOutput> {
  const clientFactory = deps.linearClientFactory ?? createFetchLinearClient;

  // 1. Project + project-scoped track existence.
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

  // 2. Adapter precondition -> CONFLICT (no HTTP). §4.14.
  const adapter = await getAdapterForProject(pool, input.project_id, ADAPTER);
  if (!adapter) {
    throw conflict('linear adapter not configured', {
      project_id: input.project_id,
      adapter: ADAPTER,
    });
  }
  const teamRaw = adapter.config['team_id'];
  const teamId = typeof teamRaw === 'string' ? teamRaw.trim() : '';
  if (!teamId) {
    throw conflict('linear adapter has no team configured', {
      project_id: input.project_id,
      adapter: ADAPTER,
    });
  }
  const stateConfig: StateConfig = {
    doneStateId: readOptionalString(adapter.config['done_state_id']),
    openStateId: readOptionalString(adapter.config['open_state_id']),
  };

  // 3. Decrypt the stored credential (never leaks the key).
  const apiKey = decryptCredential(adapter.encrypted_credential, config.encryptionKey);

  // 4. Deterministic payload + no-op hash from ONE consistent snapshot.
  const snap = await withReadSnapshot(pool, async (c) => {
    const asOf = (await c.query<{ t: Date }>('SELECT now() AS t')).rows[0]!.t;
    const t = await findTrackById(c, input.project_id, input.track_id);
    return { asOf, track: t, items: t ? await listItemsByTrack(c, t.id) : [] };
  });
  if (!snap.track) {
    throw notFound('track not found', {
      project_id: input.project_id,
      track_id: input.track_id,
    });
  }
  const syncedAt = snap.asOf;
  const payload = buildLinearPayload(
    { id: snap.track.id, title: snap.track.title, status: snap.track.status },
    snap.items.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      sequence_position: i.sequence_position,
    })),
  );
  const trackStatus = snap.track.status;
  const stateIntent = stateIntentFor(trackStatus);
  const hash = linearPayloadContentHash(payload, stateIntent, stateConfig);

  const client = clientFactory(apiKey, {
    timeoutMs: config.linearSyncTimeoutMs,
    userAgent: USER_AGENT,
  });

  // 5. Decide under a row lock; claim a fresh pending slot if none exists.
  const decision = await withTransaction(pool, async (c): Promise<Decision> => {
    const existing = await getLinkForUpdate(c, track.id, ADAPTER);
    if (existing) {
      if (existing.sync_state === 'pending') return { kind: 'pending', row: existing };
      if (existing.repo_identity !== teamId) return { kind: 'team_changed', row: existing };
      if (existing.content_hash === hash) return { kind: 'noop' };
      return { kind: 'update', row: existing };
    }
    // No link yet -> a create. We deliberately do NOT claim the pending row
    // here: the Linear workflow-state read happens first (in createFresh), so a
    // crash during that read cannot leave a wedged pending row for a create
    // that was never attempted. The claim (INSERT ... ON CONFLICT DO NOTHING)
    // still commits BEFORE the outbound mutation, preserving the durable
    // creation-intent, and its ON CONFLICT is the cross-process race guard.
    return { kind: 'create' };
  });

  const ctx: SyncCtx = {
    pool,
    client,
    teamId,
    trackId: track.id,
    payload,
    hash,
    syncedAt,
    trackStatus,
    stateConfig,
  };

  switch (decision.kind) {
    case 'noop':
      return okSynced(pool, track.id, syncedAt);
    case 'team_changed':
      return {
        ok: false,
        error: `LINEAR_UNKNOWN_ERROR: this track is linked to an issue in Linear team ${decision.row.repo_identity}, but the adapter is now configured for team ${teamId}; refusing to update a different team`,
      };
    case 'update':
      return updateExisting(ctx, decision.row);
    case 'create':
      return createFresh(ctx);
    case 'pending':
      return recoverPending(ctx, decision.row);
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface SyncCtx {
  pool: Pool;
  client: LinearClient;
  teamId: string;
  trackId: string;
  payload: LinearPayload;
  hash: string;
  syncedAt: Date;
  trackStatus: string;
  stateConfig: StateConfig;
}

type Decision =
  | { kind: 'noop' }
  | { kind: 'team_changed'; row: TrackExternalLinkRow }
  | { kind: 'update'; row: TrackExternalLinkRow }
  | { kind: 'create' }
  | { kind: 'pending'; row: TrackExternalLinkRow };

async function okSynced(pool: Pool, trackId: string, syncedAt: Date): Promise<LinearSyncOutput> {
  await withTransaction(pool, (c) => touchLinearSyncWatermark(c, trackId, syncedAt));
  return { ok: true };
}

/** Resolves the target stateId for a sync, fetching the team's workflow
 * states (and, only for a non-done reopen with an override, the issue's
 * current state) as needed. Returns { ok:false } with a LINEAR_* error for a
 * transport failure or an invalid state configuration. `stateId` undefined
 * means "leave the workflow state as-is / let Linear default it". */
async function resolveState(
  ctx: SyncCtx,
  mode: 'create' | 'update',
  issueId?: string,
): Promise<{ ok: true; stateId?: string } | { ok: false; error: string }> {
  // Fetch states when a stateId might be set (done track, or an open_state_id
  // reopen) OR when ANY override is configured — so a misconfigured
  // done_state_id/open_state_id is validated and surfaced eagerly (Codex
  // PR #25), not silently accepted until the track later becomes done.
  const needState =
    ctx.trackStatus === 'done' ||
    ctx.stateConfig.openStateId !== undefined ||
    ctx.stateConfig.doneStateId !== undefined;
  if (!needState) return { ok: true };

  const statesRes = await ctx.client.getWorkflowStates(ctx.teamId);
  if (!statesRes.ok) return { ok: false, error: statesRes.error };

  let currentStateType: string | null | undefined;
  if (
    mode === 'update' &&
    ctx.trackStatus !== 'done' &&
    ctx.stateConfig.openStateId !== undefined &&
    issueId
  ) {
    const st = await ctx.client.getIssueStateType(issueId);
    if (!st.ok) return { ok: false, error: st.error };
    currentStateType = st.value;
  }

  const resolved = resolveLinearStateId({
    states: statesRes.value,
    doneStateId: ctx.stateConfig.doneStateId,
    openStateId: ctx.stateConfig.openStateId,
    trackStatus: ctx.trackStatus,
    mode,
    currentStateType,
  });
  if ('error' in resolved) return { ok: false, error: resolved.error };
  return { ok: true, stateId: resolved.stateId };
}

async function createFresh(ctx: SyncCtx): Promise<LinearSyncOutput> {
  // Resolve the target workflow state BEFORE committing the durable pending
  // intent. This Linear-only network read has no side effect, so a crash or a
  // config/transport failure during it leaves NO pending row for a create that
  // was never attempted (Codex PR #25) — no wedge, clean retry.
  const state = await resolveState(ctx, 'create');
  if (!state.ok) return { ok: false, error: state.error };

  // Claim the durable pending intent now, BEFORE the outbound mutation. The
  // UNIQUE(track_id, adapter_type) ON CONFLICT DO NOTHING is the cross-process
  // race guard: exactly one concurrent sync wins the claim.
  const operationId = randomUUID();
  const claimed = await withTransaction(ctx.pool, (c) =>
    claimPendingLink(c, {
      trackId: ctx.trackId,
      adapterType: ADAPTER,
      repoIdentity: ctx.teamId,
      operationId,
    }),
  );
  if (!claimed) {
    return {
      ok: false,
      error: 'LINEAR_UNKNOWN_ERROR: another sync for this track is in progress; retry shortly',
    };
  }

  const created = await ctx.client.createIssue(ctx.teamId, ctx.payload, state.stateId);
  if (!created.ok) {
    if (!created.ambiguous) {
      await withTransaction(ctx.pool, (c) =>
        clearPendingLink(c, { trackId: ctx.trackId, adapterType: ADAPTER, operationId }),
      );
    }
    return { ok: false, error: created.error };
  }
  const ref = created.value;
  const finalized = await withTransaction(ctx.pool, (c) =>
    finalizeLinked(c, {
      trackId: ctx.trackId,
      adapterType: ADAPTER,
      operationId,
      externalId: ref.id,
      externalUrl: ref.url,
      contentHash: ctx.hash,
    }),
  );
  if (!finalized) {
    return {
      ok: false,
      error:
        'LINEAR_UNKNOWN_ERROR: issue created but its link could not be finalized; reconcile manually',
    };
  }
  return okSynced(ctx.pool, ctx.trackId, ctx.syncedAt);
}

async function updateExisting(ctx: SyncCtx, row: TrackExternalLinkRow): Promise<LinearSyncOutput> {
  const issueId = row.external_id;
  if (!issueId) {
    return {
      ok: false,
      error: 'LINEAR_UNKNOWN_ERROR: linked row is missing its issue id; reconcile manually',
    };
  }
  const state = await resolveState(ctx, 'update', issueId);
  if (!state.ok) return { ok: false, error: state.error };

  // As with GitHub, we do NOT hold a DB lock across this network call: the
  // decision-transaction row lock is already released. issueUpdate is
  // idempotent, there is no duplicate/lost issue, and a momentarily-stale
  // content_hash self-corrects on the next sync.
  const res = await ctx.client.updateIssue(issueId, ctx.payload, state.stateId);
  if (!res.ok) return { ok: false, error: res.error };
  await withTransaction(ctx.pool, (c) =>
    updateLinkedContentHash(c, {
      trackId: ctx.trackId,
      adapterType: ADAPTER,
      contentHash: ctx.hash,
      // Refresh the stored URL: a Linear issue's URL can change while its id
      // stays stable (team-key/workspace-slug change).
      externalUrl: res.value.url,
    }),
  );
  return okSynced(ctx.pool, ctx.trackId, ctx.syncedAt);
}

async function recoverPending(ctx: SyncCtx, row: TrackExternalLinkRow): Promise<LinearSyncOutput> {
  if (row.repo_identity !== ctx.teamId) {
    return {
      ok: false,
      error: `LINEAR_UNKNOWN_ERROR: a sync is pending for this track against Linear team ${row.repo_identity}, but the adapter is now configured for team ${ctx.teamId}; resolve the team change before retrying`,
    };
  }
  const found = await ctx.client.findIssueByMarker(ctx.teamId, trackMarker(ctx.trackId));
  if (!found.ok) return { ok: false, error: found.error };

  if (found.value) {
    // The earlier create DID happen. Reconcile the found issue to current
    // content (and state), then adopt it as linked.
    const ref = found.value;
    const state = await resolveState(ctx, 'update', ref.id);
    if (!state.ok) return { ok: false, error: state.error };
    const res = await ctx.client.updateIssue(ref.id, ctx.payload, state.stateId);
    if (!res.ok) return { ok: false, error: res.error };
    const finalized = await withTransaction(ctx.pool, (c) =>
      finalizeLinked(c, {
        trackId: ctx.trackId,
        adapterType: ADAPTER,
        operationId: row.operation_id,
        externalId: res.value.id,
        externalUrl: res.value.url,
        contentHash: ctx.hash,
      }),
    );
    if (!finalized) {
      return {
        ok: false,
        error: 'LINEAR_UNKNOWN_ERROR: adopted issue could not be finalized; reconcile manually',
      };
    }
    return okSynced(ctx.pool, ctx.trackId, ctx.syncedAt);
  }

  // Marker not found. A pending link only survives an AMBIGUOUS create, so
  // the outcome is unknown by construction; per the T5.2 design decision
  // (duplicate prevention takes priority over automatic retry when the
  // outcome cannot be established), we do NOT auto-recreate.
  return {
    ok: false,
    error:
      'LINEAR_UNKNOWN_ERROR: a previous sync did not complete and no matching issue could be found; its outcome cannot be safely confirmed, so this track is not auto-recreated (that would risk a duplicate). Clear the pending link (or use a relink tool) to resync.',
  };
}

export function registerSyncToLinearTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_sync_to_linear',
    {
      title: 'Sync to Linear',
      description:
        'Creates or updates a Linear Issue for a track (idempotent). Requires a configured Linear adapter with a team; operational Linear failures return { ok: false, error } rather than throwing.',
      inputSchema: syncToLinearInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = syncToLinearInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_sync_to_linear', () => syncToLinearService(pool, config, input));
    },
  );
}
