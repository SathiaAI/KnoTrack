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
  /** Stable tie-breaker for equal sequence_position (which the schema
   * permits) so the rendered order — and therefore the content hash — is
   * deterministic across calls. */
  id: string;
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

/** Neutralizes HTML-comment delimiters in user-controlled text (item/track
 * titles) so a title can never inject a fake `<!-- knotrack:track:… -->`
 * marker into the body — which would let recovery search match or overwrite
 * an unrelated issue — nor open a stray hidden HTML comment. HTML-escaping
 * the delimiters keeps the text readable (GitHub renders `&lt;`/`&gt;` as
 * literal `<`/`>`) while making the marker syntax impossible to form. */
function sanitize(value: string): string {
  return value.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

/** Deterministic mapping — pure function of (track, items). `done` is the
 * only terminal item/track status in the model, so a `done` track closes
 * its issue and everything else leaves it open. Items are rendered in
 * sequence order for a stable body (and therefore a stable content hash). */
export function buildIssuePayload(track: TrackForIssue, items: ItemForIssue[]): IssuePayload {
  // Escape FIRST, then enforce the limit: sanitize expands `<!--`/`-->` into
  // longer entities, so truncating before escaping could push the result back
  // over GitHub's 256-char title cap and 422 the sync.
  const title = truncate(sanitize(track.title), TITLE_MAX);
  const isDone = track.status === 'done';

  // Deterministic order: sequence_position, then id as a stable tie-breaker
  // (sequence_position is NOT unique per track), so an unchanged track always
  // renders the same body — and hashes the same — across calls.
  const ordered = [...items].sort(
    (a, b) => a.sequence_position - b.sequence_position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const header = [
    '_Synced from KnoTrack — KnoTrack owns this issue’s title, body, and open/closed state and will overwrite manual edits to them._',
    '',
    `**Track status:** \`${track.status}\``,
    '',
    '### Items',
    '',
  ].join('\n');

  // The hidden recovery marker MUST survive truncation (losing it would break
  // crash recovery -> duplicates), and the checklist is built WITHIN the
  // remaining byte budget so a long body is never silently cut without an
  // accurate "N more not shown" notice — which also changes the hash, forcing
  // a re-sync rather than a silent partial. Reserve room for the marker and a
  // worst-case notice.
  const markerBlock = `\n\n${trackMarker(track.id)}`;
  const NOTICE_RESERVE = 64;
  const budget = Math.max(0, BODY_MAX - markerBlock.length);

  const lines: string[] = [];
  let used = header.length;
  let shownCount = 0;
  for (const item of ordered) {
    if (shownCount >= ITEM_RENDER_CAP) break;
    const line = `- ${itemCheckbox(item.status)} ${sanitize(item.title)}\n`;
    const reserve = shownCount + 1 < ordered.length ? NOTICE_RESERVE : 0;
    if (used + line.length + reserve > budget) break;
    lines.push(line);
    used += line.length;
    shownCount += 1;
  }

  const omitted = ordered.length - shownCount;
  const checklist =
    shownCount > 0 ? lines.join('') : ordered.length === 0 ? '_No items yet._\n' : '';
  const notice = omitted > 0 ? `\n_… ${omitted} more item(s) not shown._` : '';

  const body = truncate(header + checklist + notice, budget) + markerBlock;

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
