// kt_update_item_status — docs/TRD.md §3.11.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { updateItemStatusInputSchema, type UpdateItemStatusInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import {
  findItemInProject,
  getUnmetDependencyIds,
  updateItemStatus,
} from '../../db/queries/items.js';
import { withTransaction } from '../../db/tx.js';
import { conflict, notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface UpdateItemStatusOutput extends Record<string, unknown> {
  ok: true;
}

export async function updateItemStatusService(
  pool: Pool,
  _config: Config,
  input: UpdateItemStatusInput,
): Promise<UpdateItemStatusOutput> {
  return withTransaction(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const item = await findItemInProject(client, input.project_id, input.item_id);
    if (!item) {
      throw notFound('item not found in this project', {
        project_id: input.project_id,
        item_id: input.item_id,
      });
    }

    // TRD §3.11: the dependency check only guards an actual transition
    // *into* done. A done -> done no-op is explicitly called out as
    // unconstrained ("no dependency check at all for those") — it's
    // already done, so re-asserting the same status isn't a pivot into
    // done that could skip past an unmet dependency.
    if (input.status === 'done' && item.status !== 'done') {
      const unmetItemIds = await getUnmetDependencyIds(client, item.id);
      if (unmetItemIds.length > 0) {
        const n = unmetItemIds.length;
        throw conflict(
          `cannot mark item done: ${n} unmet ${n === 1 ? 'dependency' : 'dependencies'}`,
          {
            item_id: item.id,
            unmet_item_ids: unmetItemIds,
          },
        );
      }
    }

    await updateItemStatus(client, item.id, input.status);

    return { ok: true };
  });
}

export function registerUpdateItemStatusTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_update_item_status',
    {
      title: 'Update item status',
      description:
        "Changes an item's status; transitioning to done requires all its dependencies to already be done.",
      inputSchema: updateItemStatusInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = updateItemStatusInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_update_item_status', () =>
        updateItemStatusService(pool, config, input),
      );
    },
  );
}
