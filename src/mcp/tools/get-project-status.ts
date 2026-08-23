// kt_get_project_status — docs/TRD.md §3.3.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { getProjectStatusInputSchema, type GetProjectStatusInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { listTracksWithItemCounts } from '../../db/queries/tracks.js';
import { listOpenDriftFlags } from '../../db/queries/drift-flags.js';
import { getRecentTimeline } from '../../db/queries/events.js';
import { withReadSnapshot } from '../../db/tx.js';
import { notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface GetProjectStatusOutput extends Record<string, unknown> {
  tracks: Array<{
    track_id: string;
    title: string;
    status: string;
    item_counts: { pending: number; in_progress: number; done: number; blocked: number };
  }>;
  drift_flags: Array<{
    flag_id: string;
    flag_type: string;
    severity: string;
    track_id: string | null;
    item_id: string | null;
    detail: string;
    status: string;
    raised_at: string;
  }>;
  recent_events: Array<{
    event_id: string;
    event_type: string;
    track_id: string | null;
    summary_text: string;
    created_at: string;
  }>;
}

const DRIFT_FLAGS_CAP = 100;
const RECENT_EVENTS_CAP = 20;

export async function getProjectStatusService(
  pool: Pool,
  _config: Config,
  input: GetProjectStatusInput,
): Promise<GetProjectStatusOutput> {
  return withReadSnapshot(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    // Sequential, not Promise.all: these now share one PoolClient (a
    // single physical connection) rather than three separate pool
    // connections, and node-postgres's Client doesn't pipeline concurrent
    // .query() calls — issuing them without awaiting in between is
    // deprecated (removed in pg@9) even though it happens to still work.
    const tracks = await listTracksWithItemCounts(client, input.project_id);
    const driftFlags = await listOpenDriftFlags(client, input.project_id, DRIFT_FLAGS_CAP);
    const timeline = await getRecentTimeline(client, input.project_id, RECENT_EVENTS_CAP);

    return {
      tracks: tracks.map((t) => ({
        track_id: t.id,
        title: t.title,
        status: t.status,
        item_counts: {
          pending: t.pending,
          in_progress: t.in_progress,
          done: t.done,
          blocked: t.blocked,
        },
      })),
      drift_flags: driftFlags.map((f) => ({
        flag_id: f.flag_id,
        flag_type: f.flag_type,
        severity: f.severity,
        track_id: f.track_id,
        item_id: f.item_id,
        detail: f.detail,
        status: f.status,
        raised_at: f.raised_at.toISOString(),
      })),
      recent_events: timeline.map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        track_id: e.track_id,
        summary_text: e.summary_text,
        created_at: e.created_at.toISOString(),
      })),
    };
  });
}

export function registerGetProjectStatusTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_get_project_status',
    {
      title: 'Get project status',
      description:
        'Roll-up view: tracks with item counts, open drift flags, and recent session-summary/decision events for a project.',
      inputSchema: getProjectStatusInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (rawArgs: unknown) => {
      const input = getProjectStatusInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_get_project_status', () =>
        getProjectStatusService(pool, config, input),
      );
    },
  );
}
