// kt_record_decision — docs/TRD.md §3.10.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { recordDecisionInputSchema, type RecordDecisionInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById, updateTrackStatus } from '../../db/queries/tracks.js';
import { insertDecision } from '../../db/queries/decisions.js';
import { withTransaction } from '../../db/tx.js';
import { notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface RecordDecisionOutput extends Record<string, unknown> {
  decision_id: string;
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

    const decision = await insertDecision(client, {
      projectId: input.project_id,
      trackId: input.track_id,
      title: input.title,
      rationale: input.rationale,
      whatChanged: input.what_changed,
    });

    // Recording a decision is, by definition, the track pivoting on
    // something — one of exactly two write paths for tracks.status (TRD
    // §3.10), the other being kt_create_track's status-at-creation logic
    // (create-track.ts). Must land in the same transaction as the
    // decisions insert above, per §3.10.
    await updateTrackStatus(client, track.id, 'pivot_pending');

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
        "Logs an explicit pivot/decision against a track; sets that track's stored status to pivot_pending.",
      inputSchema: recordDecisionInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = recordDecisionInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_record_decision', () =>
        recordDecisionService(pool, config, input),
      );
    },
  );
}
