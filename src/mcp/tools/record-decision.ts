// kt_record_decision — docs/TRD.md §3.10.
import type { Pool, PoolClient } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import {
  recordDecisionInputSchema,
  recordDecisionRegistrationSchema,
  type RecordDecisionInput,
} from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById, openTrackPivot, resolveTrackPivot } from '../../db/queries/tracks.js';
import { insertDecision } from '../../db/queries/decisions.js';
import { withTransaction } from '../../db/tx.js';
import { conflict, notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface RecordDecisionOutput extends Record<string, unknown> {
  decision_id: string;
}

/** Re-reads `tracks.pivot_decision_id` for a fresh, in-transaction view of
 * current pivot state — used only on the guarded-UPDATE-affected-0-rows
 * path below, to tell "no active pivot to resolve" apart from "a
 * different pivot is active than the caller expected" for a precise error
 * message. Cheap: a single indexed lookup, and only reached on an already
 *-failing path. */
async function getCurrentPivotDecisionId(
  client: PoolClient,
  trackId: string,
): Promise<string | null> {
  const result = await client.query<{ pivot_decision_id: string | null }>(
    `SELECT pivot_decision_id FROM tracks WHERE id = $1`,
    [trackId],
  );
  return result.rows[0]?.pivot_decision_id ?? null;
}

export async function recordDecisionService(
  pool: Pool,
  _config: Config,
  input: RecordDecisionInput,
): Promise<RecordDecisionOutput> {
  return withTransaction(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const track = await findTrackById(client, input.project_id, input.track_id);
    if (!track) {
      throw notFound('track not found in this project', {
        project_id: input.project_id,
        track_id: input.track_id,
      });
    }

    // T2.16 (final design doc §6): recording a plain 'note' decision no
    // longer has any side effect on the track's pivot state — only an
    // explicit 'open_pivot'/'resolve_pivot' touches `pivot_decision_id`.
    // This replaces the old "every decision sets tracks.status =
    // 'pivot_pending'" behavior (TRD §3.10, pre-T2.16), which conflated
    // "a decision was logged" with "the track is pivoting" and gave
    // kt_record_decision no way to represent a decision that wasn't one.
    if (input.effect === 'note') {
      const decision = await insertDecision(client, {
        projectId: input.project_id,
        trackId: input.track_id,
        title: input.title,
        rationale: input.rationale,
        whatChanged: input.what_changed,
        effect: 'note',
      });
      return { decision_id: decision.id };
    }

    if (input.effect === 'open_pivot') {
      const decision = await insertDecision(client, {
        projectId: input.project_id,
        trackId: input.track_id,
        title: input.title,
        rationale: input.rationale,
        whatChanged: input.what_changed,
        effect: 'open_pivot',
      });
      const affected = await openTrackPivot(client, input.track_id, decision.id);
      if (affected === 0) {
        throw conflict('track already has an active pivot — resolve it before opening a new one', {
          project_id: input.project_id,
          track_id: input.track_id,
        });
      }
      return { decision_id: decision.id };
    }

    // input.effect === 'resolve_pivot' (the only remaining case; the
    // schema's superRefine guarantees expected_pivot_decision_id is set).
    const expectedPivotDecisionId = input.expected_pivot_decision_id;
    if (expectedPivotDecisionId === undefined) {
      // Unreachable given the schema's superRefine — narrows the type for
      // the insertDecision call below without an `!` assertion.
      throw notFound('expected_pivot_decision_id is required to resolve a pivot');
    }

    // Checked against the track row already fetched above, BEFORE
    // inserting the resolve-decision row: `resolves_decision_id` has a
    // real FK to `decisions.id` (migrations/006_derived_track_status.sql),
    // so inserting with a caller-supplied id that doesn't match any
    // actual open pivot would otherwise surface as a raw FK-violation
    // database error instead of a clean 409. This also gives a precise
    // message distinguishing "no active pivot at all" (T2.16 final design
    // doc §6: must be a hard error, not a silent no-op) from "a different
    // pivot is active than the caller expected". A true concurrent race
    // between this check and the guarded UPDATE below is still caught by
    // that UPDATE's own affected-row check, since both run inside this
    // same transaction against the current committed state.
    if (track.pivot_decision_id === null) {
      throw conflict('track has no active pivot to resolve', {
        project_id: input.project_id,
        track_id: input.track_id,
      });
    }
    if (track.pivot_decision_id !== expectedPivotDecisionId) {
      throw conflict('pivot changed since you last read this track', {
        project_id: input.project_id,
        track_id: input.track_id,
        expected_pivot_decision_id: expectedPivotDecisionId,
        current_pivot_decision_id: track.pivot_decision_id,
      });
    }

    const decision = await insertDecision(client, {
      projectId: input.project_id,
      trackId: input.track_id,
      title: input.title,
      rationale: input.rationale,
      whatChanged: input.what_changed,
      effect: 'resolve_pivot',
      resolvesDecisionId: expectedPivotDecisionId,
    });
    const affected = await resolveTrackPivot(client, input.track_id, expectedPivotDecisionId);
    if (affected === 0) {
      // A genuine race: pivot state changed between the check above and
      // this UPDATE (another transaction committed in between).
      const currentPivotDecisionId = await getCurrentPivotDecisionId(client, input.track_id);
      throw conflict('pivot changed since you last read this track', {
        project_id: input.project_id,
        track_id: input.track_id,
        expected_pivot_decision_id: expectedPivotDecisionId,
        current_pivot_decision_id: currentPivotDecisionId,
      });
    }
    return { decision_id: decision.id };
  });
}

export function registerRecordDecisionTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_record_decision',
    {
      title: 'Record decision',
      description:
        "Logs a decision against a track. `effect: 'open_pivot'` opens a pivot on that track " +
        "(pivot_pending); `effect: 'resolve_pivot'` (with expected_pivot_decision_id) closes one; " +
        "the default `effect: 'note'` just logs the decision with no lifecycle side effect.",
      inputSchema: recordDecisionRegistrationSchema,
    },
    async (rawArgs: unknown) => {
      const input = recordDecisionInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_record_decision', () =>
        recordDecisionService(pool, config, input),
      );
    },
  );
}
