// track_external_links access (migrations/009, docs/ROADMAP.md T5.2).
//
// The authoritative idempotency store for kt_sync_to_github. Every function
// that mutates a link expects to run inside a withTransaction client so the
// row lock / unique-conflict claim is atomic; the read used before a sync
// (`getLinkForUpdate`) takes `FOR UPDATE` and therefore also needs a
// transaction client, never a bare Pool.
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export type SyncState = 'pending' | 'linked';

export interface TrackExternalLinkRow {
  id: string;
  track_id: string;
  adapter_type: 'github' | 'linear';
  sync_state: SyncState;
  external_id: string | null;
  external_url: string | null;
  repo_identity: string;
  content_hash: string | null;
  operation_id: string;
  created_at: Date;
  updated_at: Date;
}

/** Reads the link for (track, type) and locks the row for the rest of the
 * transaction, so a concurrent sync of the same track serializes behind it
 * instead of both reaching the create decision. Returns undefined when no
 * link exists yet. Must be called on a transaction client. */
export async function getLinkForUpdate(
  client: PoolClient,
  trackId: string,
  adapterType: 'github' | 'linear',
): Promise<TrackExternalLinkRow | undefined> {
  const result = await client.query<TrackExternalLinkRow>(
    `SELECT * FROM track_external_links
     WHERE track_id = $1 AND adapter_type = $2
     FOR UPDATE`,
    [trackId, adapterType],
  );
  return result.rows[0];
}

/** Atomically claims a fresh `pending` creation slot. The UNIQUE(track_id,
 * adapter_type) constraint makes this the real cross-process guard: if two
 * syncs race, exactly one INSERT returns a row and the other gets undefined
 * (its `getLinkForUpdate` re-read will then see the winner's row). The
 * claim is meant to be COMMITTED before any outbound POST, so a crash mid-
 * create leaves this durable `pending` marker behind. */
export async function claimPendingLink(
  client: PoolClient,
  input: {
    trackId: string;
    adapterType: 'github' | 'linear';
    repoIdentity: string;
    operationId: string;
  },
): Promise<TrackExternalLinkRow | undefined> {
  const result = await client.query<TrackExternalLinkRow>(
    `INSERT INTO track_external_links
       (track_id, adapter_type, sync_state, repo_identity, operation_id)
     VALUES ($1, $2, 'pending', $3, $4)
     ON CONFLICT (track_id, adapter_type) DO NOTHING
     RETURNING *`,
    [input.trackId, input.adapterType, input.repoIdentity, input.operationId],
  );
  return result.rows[0];
}

/** Transitions a `pending` claim (identified by its operation_id) to
 * `linked`, recording the real issue identity and content hash. Returns the
 * updated row, or undefined if the guard didn't match (the pending row was
 * cleared or reclaimed under a different operation_id meanwhile) — the
 * caller treats that as "someone else finalized" and does not retry blind. */
export async function finalizeLinked(
  client: PoolClient,
  input: {
    trackId: string;
    adapterType: 'github' | 'linear';
    operationId: string;
    externalId: string;
    externalUrl: string;
    contentHash: string;
  },
): Promise<TrackExternalLinkRow | undefined> {
  const result = await client.query<TrackExternalLinkRow>(
    `UPDATE track_external_links
       SET sync_state = 'linked',
           external_id = $3,
           external_url = $4,
           content_hash = $5,
           repo_identity = repo_identity
     WHERE track_id = $1 AND adapter_type = $2 AND operation_id = $6
     RETURNING *`,
    [
      input.trackId,
      input.adapterType,
      input.externalId,
      input.externalUrl,
      input.contentHash,
      input.operationId,
    ],
  );
  return result.rows[0];
}

/** Records a new content hash on an already-`linked` row after a successful
 * PATCH reconcile. external_id/url are unchanged (same issue). */
export async function updateLinkedContentHash(
  client: PoolClient,
  input: {
    trackId: string;
    adapterType: 'github' | 'linear';
    contentHash: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE track_external_links
       SET content_hash = $3
     WHERE track_id = $1 AND adapter_type = $2 AND sync_state = 'linked'`,
    [input.trackId, input.adapterType, input.contentHash],
  );
}

/** Deletes our own `pending` claim (guarded by operation_id) so a fresh
 * create can proceed. Used when a create failed in a way that proves no
 * issue was created (a definitive GitHub rejection), or when marker-based
 * recovery has established the issue does not exist. */
export async function clearPendingLink(
  client: PoolClient,
  input: {
    trackId: string;
    adapterType: 'github' | 'linear';
    operationId: string;
  },
): Promise<void> {
  await client.query(
    `DELETE FROM track_external_links
     WHERE track_id = $1 AND adapter_type = $2 AND sync_state = 'pending' AND operation_id = $3`,
    [input.trackId, input.adapterType, input.operationId],
  );
}

/** The linked GitHub issue URL for a track, or null — surfaced on
 * kt_get_track so "records the issue URL on the track" is observable
 * through the item/track read contract without denormalizing the URL onto
 * the tracks table. Only a `linked` row exposes a URL. */
export async function getGithubIssueUrlForTrack(
  db: Queryable,
  trackId: string,
): Promise<string | null> {
  const result = await db.query<{ external_url: string | null }>(
    `SELECT external_url FROM track_external_links
     WHERE track_id = $1 AND adapter_type = 'github' AND sync_state = 'linked'
     LIMIT 1`,
    [trackId],
  );
  return result.rows[0]?.external_url ?? null;
}

/** The linked Linear issue URL for a track, or null when unlinked (T5.3).
 * Sibling of getGithubIssueUrlForTrack; kept adapter-specific for the same
 * reason — callers ask for one destination's URL, never "some" URL. */
export async function getLinearIssueUrlForTrack(
  db: Queryable,
  trackId: string,
): Promise<string | null> {
  const result = await db.query<{ external_url: string | null }>(
    `SELECT external_url FROM track_external_links
     WHERE track_id = $1 AND adapter_type = 'linear' AND sync_state = 'linked'
     LIMIT 1`,
    [trackId],
  );
  return result.rows[0]?.external_url ?? null;
}
