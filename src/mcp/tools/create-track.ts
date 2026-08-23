// kt_create_track — docs/TRD.md §3.6.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { createTrackInputSchema, type CreateTrackInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import {
  getTrackDependencyEdges,
  getTrackStatusesForProject,
  insertTrack,
  insertTrackDependencies,
} from '../../db/queries/tracks.js';
import { wouldCreateCycle } from '../../domain/dependency-graph.js';
import { withTransaction } from '../../db/tx.js';
import { conflict, notFound, validationError } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface CreateTrackOutput extends Record<string, unknown> {
  track_id: string;
}

export async function createTrackService(
  pool: Pool,
  _config: Config,
  input: CreateTrackInput,
): Promise<CreateTrackOutput> {
  const dependsOn = Array.from(new Set(input.depends_on));

  return withTransaction(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const trackStatuses = await getTrackStatusesForProject(client, input.project_id);
    const missing = dependsOn.filter((id) => !trackStatuses.has(id));
    if (missing.length > 0) {
      throw notFound('one or more depends_on tracks do not exist in this project', {
        project_id: input.project_id,
        missing_track_ids: missing,
      });
    }

    // Cycle check across the project's existing track_dependencies plus
    // the proposed new node/edges (TRD §3.6's "systemic invariant").
    const existingEdges = await getTrackDependencyEdges(client, input.project_id);
    // The new track doesn't have an id yet; use a sentinel that cannot
    // collide with a real UUID, then verify the cycle check below.
    const sentinel = '00000000-0000-0000-0000-000000000000';
    if (trackStatuses.has(sentinel)) {
      throw validationError('internal sentinel collision — retry');
    }
    if (wouldCreateCycle(existingEdges, sentinel, dependsOn)) {
      throw conflict('dependency cycle detected', {
        project_id: input.project_id,
        depends_on: dependsOn,
      });
    }

    const allDependenciesDone = dependsOn.every((id) => trackStatuses.get(id) === 'done');
    const status = dependsOn.length === 0 || allDependenciesDone ? 'on_track' : 'blocked';

    const track = await insertTrack(client, {
      projectId: input.project_id,
      title: input.title,
      status,
      sourceDocRef: input.source_doc_ref,
    });

    await insertTrackDependencies(client, track.id, dependsOn);

    return { track_id: track.id };
  });
}

export function registerCreateTrackTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_create_track',
    {
      title: 'Create track',
      description:
        'Creates a Track under a project, validating depends_on tracks and rejecting dependency cycles.',
      inputSchema: createTrackInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = rawArgs as CreateTrackInput;
      return runTool(logger, 'kt_create_track', () => createTrackService(pool, config, input));
    },
  );
}
