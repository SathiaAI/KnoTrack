// Pure track -> Linear Issue payload mapping, content hashing, and workflow-
// state resolution for kt_sync_to_linear (docs/PRD.md §4.14, docs/ROADMAP.md
// T5.3). Side-effect-free and free of any DB/HTTP import (the LinearWorkflowState
// type is imported type-only) so the mapping, the no-op hash, and the state
// resolver are unit-testable in isolation.
//
// KnoTrack owns exactly the issue title, description, and — for a done track —
// its workflow state. The description carries the same hidden recovery marker
// as the GitHub body (reused via issue-payload.ts), used ONLY for crash
// recovery, never as the authoritative create-vs-update key (that is the
// track_external_links row).
import { createHash } from 'node:crypto';
import { sanitize, truncate, trackMarker } from './issue-payload.js';
import type { LinearWorkflowState } from '../../linear/linear-client.js';

// Linear's issue title limit; we stay under it rather than letting the API
// reject the mutation.
const TITLE_MAX = 255;
// Linear descriptions allow large markdown; bound worst-case body size the
// same way GitHub does so a huge track can't render an unbounded checklist.
const DESC_MAX = 65_536;
const ITEM_RENDER_CAP = 300;

export interface TrackForLinear {
  id: string;
  title: string;
  /** Derived track status: on_track | pivot_pending | blocked | done. */
  status: string;
}

export interface ItemForLinear {
  id: string;
  title: string;
  status: string;
  sequence_position: number;
}

export interface LinearPayload {
  title: string;
  description: string;
}

/** 'done' when the track is terminal, else 'open'. Folded into the content
 * hash so flipping a track's done-ness always forces a re-sync (which lets
 * the state resolver move the Linear issue to/from a completed state). */
export function stateIntentFor(trackStatus: string): 'done' | 'open' {
  return trackStatus === 'done' ? 'done' : 'open';
}

function itemCheckbox(status: string): string {
  return status === 'done' ? '[x]' : '[ ]';
}

/** Deterministic mapping — pure function of (track, items). Mirrors the
 * GitHub body (issue-payload.ts) but targets Linear's {title, description}
 * and omits the open/closed field (Linear state is a separate stateId
 * resolved by resolveLinearStateId). */
export function buildLinearPayload(track: TrackForLinear, items: ItemForLinear[]): LinearPayload {
  // Escape FIRST, then enforce the limit (sanitize expands `<!--`/`-->` into
  // longer entities), matching the GitHub title fix.
  const title = truncate(sanitize(track.title), TITLE_MAX);

  const ordered = [...items].sort(
    (a, b) => a.sequence_position - b.sequence_position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const header = [
    '_Synced from KnoTrack — KnoTrack owns this issue’s title, description, and (when the track is done) its workflow state, and will overwrite manual edits to them._',
    '',
    `**Track status:** \`${track.status}\``,
    '',
    '### Items',
    '',
  ].join('\n');

  const markerBlock = `\n\n${trackMarker(track.id)}`;
  const NOTICE_RESERVE = 64;
  const budget = Math.max(0, DESC_MAX - markerBlock.length);

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

  const description = truncate(header + checklist + notice, budget) + markerBlock;

  return { title, description };
}

/** sha256 of exactly what KnoTrack pushes to Linear: title, description, the
 * abstract state intent (done|open), and the configured state overrides. The
 * intent (not an auto-resolved stateId) keeps a team's auto-picked state UUIDs
 * out of the hash — those differ per team and would cause needless churn — while
 * a done/undone flip still re-syncs; the operator-configured done_state_id/
 * open_state_id ARE included so changing them re-syncs. Detects KnoTrack-side
 * changes only. */
export function linearPayloadContentHash(
  payload: LinearPayload,
  stateIntent: 'done' | 'open',
  stateConfig: { doneStateId?: string; openStateId?: string } = {},
): string {
  const canonical = JSON.stringify({
    title: payload.title,
    description: payload.description,
    state_intent: stateIntent,
    // The configured overrides are part of what a sync would push: if a project
    // is re-registered with a different done_state_id/open_state_id, the hash
    // must change so the linked issue is re-synced (and the new override
    // re-validated) instead of taking a false no-op path (Codex PR #25).
    done_state_id: stateConfig.doneStateId ?? null,
    open_state_id: stateConfig.openStateId ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type StateResolution = { stateId?: string } | { error: string };

function lowestPosition(states: LinearWorkflowState[]): LinearWorkflowState | undefined {
  return states.reduce<LinearWorkflowState | undefined>((best, s) => {
    if (!best) return s;
    if (s.position < best.position) return s;
    if (s.position === best.position && s.id < best.id) return s;
    return best;
  }, undefined);
}

/** The single shared workflow-state resolver (frontier checklist item 15).
 *
 * - done track: set the configured `done_state_id`, or (default) the team's
 *   lowest-position 'completed' state. Fails LINEAR_STATE_CONFIG when the
 *   override is unknown/not 'completed', or when no completed state exists
 *   and none is configured.
 * - non-done track: NEVER auto-moves the issue (frontier checklist item 2).
 *   It moves backward only when an explicit, valid `open_state_id` is
 *   configured AND (on update) the issue is currently in a completed/canceled
 *   state. On create with `open_state_id` set, new issues are placed there;
 *   with none set, Linear assigns the team default.
 *
 * Returns `{}` (no stateId) to mean "leave the state as-is / let Linear
 * decide", or `{ error }` for an invalid configuration. */
export function resolveLinearStateId(args: {
  states: LinearWorkflowState[];
  doneStateId?: string;
  openStateId?: string;
  trackStatus: string;
  mode: 'create' | 'update';
  currentStateType?: string | null;
}): StateResolution {
  const { states, doneStateId, openStateId, trackStatus, mode, currentStateType } = args;
  const byId = new Map(states.map((s) => [s.id, s]));

  if (doneStateId !== undefined) {
    const s = byId.get(doneStateId);
    if (!s)
      return {
        error: `LINEAR_STATE_CONFIG: configured done_state_id is not a workflow state of this team`,
      };
    if (s.type !== 'completed')
      return {
        error: `LINEAR_STATE_CONFIG: configured done_state_id is a '${s.type}' state, not 'completed'`,
      };
  }
  if (openStateId !== undefined) {
    const s = byId.get(openStateId);
    if (!s)
      return {
        error: `LINEAR_STATE_CONFIG: configured open_state_id is not a workflow state of this team`,
      };
    if (s.type === 'completed' || s.type === 'canceled')
      return {
        error: `LINEAR_STATE_CONFIG: configured open_state_id is a '${s.type}' (terminal) state; choose a non-terminal (backlog/unstarted/started) state to reopen into`,
      };
  }

  if (trackStatus === 'done') {
    const chosen = doneStateId ?? lowestPosition(states.filter((s) => s.type === 'completed'))?.id;
    if (!chosen)
      return {
        error: `LINEAR_STATE_CONFIG: this team has no 'completed' workflow state; set done_state_id on the Linear adapter`,
      };
    return { stateId: chosen };
  }

  // Non-done: never auto-move. Only an explicit open_state_id can set state.
  if (openStateId === undefined) return {};
  if (mode === 'create') return { stateId: openStateId };
  // Update: only reopen (move backward) if the issue is currently done/canceled.
  if (currentStateType === 'completed' || currentStateType === 'canceled')
    return { stateId: openStateId };
  return {};
}
