// kt_get_next_steps — docs/TRD.md §3.8. Advisory only: this tool never
// assigns, claims, or locks an item, it only ranks candidates.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { getNextStepsInputSchema, type GetNextStepsInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { getTrackSummariesForProject, getTrackDependencyEdges } from '../../db/queries/tracks.js';
import { listPendingItemsForProject, getItemStatusesByIds } from '../../db/queries/items.js';
import { withReadSnapshot } from '../../db/tx.js';
import { notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';
import { rankNextSteps, type RecommendedItem } from '../../domain/next-steps.js';

export interface GetNextStepsOutput extends Record<string, unknown> {
  recommended_items: RecommendedItem[];
}

export async function getNextStepsService(
  pool: Pool,
  config: Config,
  input: GetNextStepsInput,
): Promise<GetNextStepsOutput> {
  return withReadSnapshot(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    // Sequential, not Promise.all: these share one PoolClient — see
    // get-project-status.ts's comment on why these aren't run concurrently.
    const tracks = await getTrackSummariesForProject(client, input.project_id);
    const trackEdges = await getTrackDependencyEdges(client, input.project_id);
    const pendingItems = await listPendingItemsForProject(client, input.project_id);

    // adversarial-review P2: only look up the status of items actually
    // referenced as a dependency by some pending item, not every item in
    // the project (getItemStatusesByIds's own comment has the full
    // reasoning) — pendingItems is already the project's full pending
    // backlog (a semantically bounded, not "the whole project", quantity:
    // it's specifically the currently-actionable items this tool exists
    // to rank), materializing that plus a bounded dependency-status
    // lookup keeps this tool proportional to its own advisory scope
    // rather than the project's entire item history.
    const dependencyIds = Array.from(
      new Set(pendingItems.flatMap((item) => item.depends_on_item_ids)),
    );
    const itemStatusById = await getItemStatusesByIds(client, dependencyIds);

    // T2.16: a track's direct dependencies must all be effective_done —
    // the fully-transitive fact — not merely "locally OK", for that
    // track's items to be safe to recommend. A track with no dependencies
    // is vacuously true. See next-steps.ts's NextStepsTrackInput doc
    // comment for the full reasoning.
    const effectiveDoneById = new Map(tracks.map((t) => [t.id, t.effective_done]));
    const directDepsByTrack = new Map<string, string[]>();
    for (const edge of trackEdges) {
      const list = directDepsByTrack.get(edge.from);
      if (list) {
        list.push(edge.to);
      } else {
        directDepsByTrack.set(edge.from, [edge.to]);
      }
    }
    const tracksById = new Map(
      tracks.map((t) => [
        t.id,
        {
          title: t.title,
          status: t.status,
          dependenciesEffectivelyDone: (directDepsByTrack.get(t.id) ?? []).every(
            (depId) => effectiveDoneById.get(depId) === true,
          ),
        },
      ]),
    );

    const recommended_items = rankNextSteps(
      pendingItems.map((item) => ({
        id: item.id,
        track_id: item.track_id,
        title: item.title,
        sequence_position: item.sequence_position,
        created_at: item.created_at,
        dependsOnItemIds: item.depends_on_item_ids,
      })),
      tracksById,
      itemStatusById,
      config.nextStepsLimit,
    );

    return { recommended_items };
  });
}

export function registerGetNextStepsTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_get_next_steps',
    {
      title: 'Get next steps',
      description:
        'Advisory-only ranked list of unblocked items. Never assigns, claims, or locks anything.',
      inputSchema: getNextStepsInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (rawArgs: unknown) => {
      const input = getNextStepsInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_get_next_steps', () => getNextStepsService(pool, config, input));
    },
  );
}
