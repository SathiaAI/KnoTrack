// kt_sync_to_linear — docs/PRD.md §4.14 (T2.14 stub slice).
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { syncToLinearInputSchema, type SyncToLinearInput } from '../../schemas/tools.js';
import { runTool } from '../tool-helpers.js';
import { syncAdapterStub, type SyncOutput } from './sync-shared.js';

export async function syncToLinearService(
  pool: Pool,
  _config: Config,
  input: SyncToLinearInput,
): Promise<SyncOutput> {
  return syncAdapterStub(pool, 'linear', input);
}

export function registerSyncToLinearTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_sync_to_linear',
    {
      title: 'Sync to Linear',
      description:
        'Pushes a track to a linked Linear Issue. Requires a configured Linear adapter; external sync is not available in this build.',
      inputSchema: syncToLinearInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = syncToLinearInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_sync_to_linear', () => syncToLinearService(pool, config, input));
    },
  );
}
