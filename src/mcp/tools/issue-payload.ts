// Pure track -> GitHub Issue payload mapping + content hashing for
// kt_sync_to_github (docs/PRD.md §4.13, docs/ROADMAP.md T5.2).
//
// Kept side-effect-free and free of any DB/HTTP import so the mapping and
// the no-op-detection hash are unit-testable in isolation. KnoTrack owns
// exactly three fields on the issue — title, body, state — and nothing
// else (no labels/assignees/milestones); the body carries a hidden marker
// used ONLY for crash recovery, never as the authoritative create-vs-update
// key (that is the track_external_links row).
import { createHash } from 'node:crypto';

// GitHub hard limits we stay under rather than letting the API 422.
const TITLE_MAX = 256;
const BODY_MAX = 65_536;
// A very large track would otherwise render an unbounded checklist into the
// body; cap the rendered items and note the elision. Generous vs a real
// track's item count while bounding worst-case body size.
const ITEM_RENDER_CAP = 300;

export interface TrackForIssue {
  id: string;
  title: string;
  /** Derived track status (T2.16): on_track | pivot_pending | blocked | done. */
  status: string;
}

export interface ItemForIssue {
  title: string;
  /** Item status: pending | in_progress | done | blocked. */
  status: string;
  sequence_position: number;
}

export interface IssuePayload {
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Only set when closing, so GitHub records *why*. */
  state_reason?: 'completed';
}

/** The hidden HTML comment embedded in the issue body. Recovery-only: after
 * a crash that left a `pending` link, the sync tool searches for this exact
 * string to decide whether the create actually happened. Never parsed as
 * the normal idempotency key. */
export function trackMarker(trackId: string): string {
  return `<!-- knotrack:track:${trackId} -->`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function itemCheckbox(status: string): string {
  return status === 'done' ? '[x]' : '[ ]';
}

/** Deterministic mapping — pure function of (track, items). `done` is the
 * only terminal item/track status in the model, so a `done` track closes
 * its issue and everything else leaves it open. Items are rendered in
 * sequence order for a stable body (and therefore a stable content hash). */
export function buildIssuePayload(track: TrackForIssue, items: ItemForIssue[]): IssuePayload {
  const title = truncate(track.title, TITLE_MAX);
  const isDone = track.status === 'done';

  const ordered = [...items].sort((a, b) => a.sequence_position - b.sequence_position);
  const shown = ordered.slice(0, ITEM_RENDER_CAP);
  const checklist = shown.map((i) => `- ${itemCheckbox(i.status)} ${i.title}`).join('\n');
  const elided =
    ordered.length > shown.length
      ? `\n\n_… ${ordered.length - shown.length} more item(s) not shown._`
      : '';

  const content = [
    '_Synced from KnoTrack — KnoTrack owns this issue’s title, body, and open/closed state and will overwrite manual edits to them._',
    '',
    `**Track status:** \`${track.status}\``,
    '',
    '### Items',
    checklist.length > 0 ? checklist : '_No items yet._',
    elided,
  ].join('\n');

  // The hidden recovery marker MUST survive truncation: if a very long body
  // were cut with the marker at the end, crash recovery could not find the
  // issue and would create a duplicate. So reserve room for the marker and
  // truncate the content, never the marker.
  const markerBlock = `\n\n${trackMarker(track.id)}`;
  const room = Math.max(0, BODY_MAX - markerBlock.length);
  const body = truncate(content, room) + markerBlock;

  const payload: IssuePayload = {
    title,
    body,
    state: isDone ? 'closed' : 'open',
  };
  if (isDone) {
    payload.state_reason = 'completed';
  }
  return payload;
}

/** sha256 of the canonical, ordered representation of exactly the fields
 * KnoTrack pushes. A re-sync whose payload hashes to the stored value is a
 * no-op (no HTTP call). Note: this detects KnoTrack-side changes only — it
 * cannot detect an issue edited, deleted, or made inaccessible on GitHub. */
export function payloadContentHash(payload: IssuePayload): string {
  const canonical = JSON.stringify({
    title: payload.title,
    body: payload.body,
    state: payload.state,
    state_reason: payload.state_reason ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
