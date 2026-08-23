// kt_create_item — docs/TRD.md §3.7.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { createItemInputSchema, type CreateItemInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById } from '../../db/queries/tracks.js';
import {
  getItemDependencyEdgesForTrack,
  getItemsByIds,
  getMaxSequencePosition,
  insertItem,
  insertItemDependencies,
  listItemsByTrack,
  lockTrackForSequenceAssignment,
} from '../../db/queries/items.js';
import { wouldCreateCycle } from '../../domain/dependency-graph.js';
import { withTransaction } from '../../db/tx.js';
import { conflict, notFound, validationError } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface CreateItemOutput extends Record<string, unknown> {
  item_id: string;
}

export async function createItemService(
  pool: Pool,
  _config: Config,
  input: CreateItemInput,
): Promise<CreateItemOutput> {
  const dependsOn = Array.from(new Set(input.depends_on));

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

    if (dependsOn.length > 0) {
      const foundItems = await getItemsByIds(client, dependsOn);
      const notFoundIds = dependsOn.filter((id) => !foundItems.has(id));
      if (notFoundIds.length > 0) {
        throw notFound('one or more depends_on ids do not exist as items at all', {
          missing_item_ids: notFoundIds,
        });
      }
      const wrongTrackIds = dependsOn.filter((id) => foundItems.get(id)?.track_id !== track.id);
      if (wrongTrackIds.length > 0) {
        throw validationError(
          'depends_on ids must belong to the same track as the item being created',
          { wrong_track_item_ids: wrongTrackIds, track_id: track.id },
        );
      }
    }

    // The new item doesn't have an id yet; use a sentinel that cannot
    // collide with a real item id (adversarial-review correctness-2: an
    // item actually inserted with this literal nil UUID — not possible via
    // any tool today, since insertItem relies on gen_random_uuid(), but not
    // enforced — would otherwise make this check produce a wrong result).
    // Checked against every item in the track, matching create-track.ts's
    // equivalent trackStatuses.has(sentinel) check against every track in
    // the project, not just ones with dependency edges.
    const sentinel = '00000000-0000-0000-0000-000000000000';
    const trackItems = await listItemsByTrack(client, track.id);
    if (trackItems.some((item) => item.id === sentinel)) {
      throw validationError('internal sentinel collision — retry');
    }
    const existingEdges = await getItemDependencyEdgesForTrack(client, track.id);
    if (wouldCreateCycle(existingEdges, sentinel, dependsOn)) {
      throw conflict('dependency cycle detected', {
        track_id: track.id,
        depends_on: dependsOn,
      });
    }

    // adversarial-review correctness-1: lock the track row before reading
    // the current max so two concurrent auto-assigns on the same track
    // serialize instead of both computing the same next position. Only
    // needed on the auto-assign path — an explicit sequence_position is a
    // plain write with no prior read to race.
    let sequencePosition: number;
    if (input.sequence_position !== undefined) {
      sequencePosition = input.sequence_position;
    } else {
      await lockTrackForSequenceAssignment(client, track.id);
      sequencePosition = (await getMaxSequencePosition(client, track.id)) + 1;
    }

    const item = await insertItem(client, {
      trackId: track.id,
      title: input.title,
      sequencePosition,
    });

    await insertItemDependencies(client, item.id, dependsOn);

    return { item_id: item.id };
  });
}

export function registerCreateItemTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_create_item',
    {
      title: 'Create item',
      description:
        'Creates an Item under a Track, validating same-track depends_on ids and rejecting dependency cycles.',
      inputSchema: createItemInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = rawArgs as CreateItemInput;
      return runTool(logger, 'kt_create_item', () => createItemService(pool, config, input));
    },
  );
}
