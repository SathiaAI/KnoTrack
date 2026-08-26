// kt_get_track — docs/TRD.md §3.5.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { getTrackInputSchema, type GetTrackInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById, getDependsOnTrackIds } from '../../db/queries/tracks.js';
import { getItemDependencyEdgesForTrack, listItemsByTrack } from '../../db/queries/items.js';
import { withReadSnapshot } from '../../db/tx.js';
import { notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface GetTrackOutput extends Record<string, unknown> {
  track: {
    track_id: string;
    title: string;
    status: string;
    source_doc_ref: string | null;
    depends_on_track_ids: string[];
    created_at: string;
  };
  items: Array<{
    item_id: string;
    title: string;
    status: string;
    sequence_position: number;
    depends_on_item_ids: string[];
  }>;
  dependency_graph: {
    nodes: Array<{ item_id: string; title: string; status: string }>;
    edges: Array<{ item_id: string; depends_on_item_id: string }>;
  };
}

export async function getTrackService(
  pool: Pool,
  _config: Config,
  input: GetTrackInput,
): Promise<GetTrackOutput> {
  return withReadSnapshot(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const track = await findTrackById(client, input.project_id, input.track_id);
    if (!track) {
      throw notFound('track not found', {
        project_id: input.project_id,
        track_id: input.track_id,
      });
    }

    // Sequential on this one shared PoolClient — see get-project-status.ts's
    // comment on why these aren't run as a Promise.all.
    const dependsOnTrackIds = await getDependsOnTrackIds(client, track.id);
    const items = await listItemsByTrack(client, track.id);
    const itemEdges = await getItemDependencyEdgesForTrack(client, track.id);

    const dependsOnByItemId = new Map<string, string[]>();
    for (const edge of itemEdges) {
      const list = dependsOnByItemId.get(edge.from);
      if (list) {
        list.push(edge.to);
      } else {
        dependsOnByItemId.set(edge.from, [edge.to]);
      }
    }

    return {
      track: {
        track_id: track.id,
        title: track.title,
        status: track.status,
        source_doc_ref: track.source_doc_ref,
        depends_on_track_ids: dependsOnTrackIds,
        created_at: track.created_at.toISOString(),
      },
      items: items.map((item) => ({
        item_id: item.id,
        title: item.title,
        status: item.status,
        sequence_position: item.sequence_position,
        depends_on_item_ids: dependsOnByItemId.get(item.id) ?? [],
      })),
      dependency_graph: {
        nodes: items.map((item) => ({ item_id: item.id, title: item.title, status: item.status })),
        edges: itemEdges.map((edge) => ({
          item_id: edge.from,
          depends_on_item_id: edge.to,
        })),
      },
    };
  });
}

export function registerGetTrackTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_get_track',
    {
      title: 'Get track',
      description: 'Track detail: items plus dependency graph.',
      inputSchema: getTrackInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (rawArgs: unknown) => {
      const input = getTrackInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_get_track', () => getTrackService(pool, config, input));
    },
  );
}
