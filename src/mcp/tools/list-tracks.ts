// kt_list_tracks — docs/TRD.md §3.4.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { listTracksInputSchema, type ListTracksInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { listTracksForListing } from '../../db/queries/tracks.js';
import { withReadSnapshot } from '../../db/tx.js';
import { notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface ListTracksOutput extends Record<string, unknown> {
  tracks: Array<{
    track_id: string;
    title: string;
    status: string;
    source_doc_ref: string | null;
    depends_on_track_ids: string[];
    item_counts: { pending: number; in_progress: number; done: number; blocked: number };
    created_at: string;
  }>;
}

export async function listTracksService(
  pool: Pool,
  _config: Config,
  input: ListTracksInput,
): Promise<ListTracksOutput> {
  return withReadSnapshot(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const tracks = await listTracksForListing(client, input.project_id, input.status);

    return {
      tracks: tracks.map((t) => ({
        track_id: t.id,
        title: t.title,
        status: t.status,
        source_doc_ref: t.source_doc_ref,
        depends_on_track_ids: t.depends_on_track_ids,
        item_counts: {
          pending: t.pending,
          in_progress: t.in_progress,
          done: t.done,
          blocked: t.blocked,
        },
        created_at: t.created_at.toISOString(),
      })),
    };
  });
}

export function registerListTracksTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_list_tracks',
    {
      title: 'List tracks',
      description: "List a project's tracks, optionally filtered by status.",
      inputSchema: listTracksInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (rawArgs: unknown) => {
      const input = listTracksInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_list_tracks', () => listTracksService(pool, config, input));
    },
  );
}
