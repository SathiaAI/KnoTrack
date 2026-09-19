// kt_sync_to_github — docs/PRD.md §4.13 (T2.13 stub slice).
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { syncToGithubInputSchema, type SyncToGithubInput } from '../../schemas/tools.js';
import { runTool } from '../tool-helpers.js';
import { syncAdapterStub, type SyncOutput } from './sync-shared.js';

export async function syncToGithubService(
  pool: Pool,
  _config: Config,
  input: SyncToGithubInput,
): Promise<SyncOutput> {
  return syncAdapterStub(pool, 'github', input);
}

export function registerSyncToGithubTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_sync_to_github',
    {
      title: 'Sync to GitHub',
      description:
        'Pushes a track to a linked GitHub Issue. Requires a configured GitHub adapter; external sync is not available in this build.',
      inputSchema: syncToGithubInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = syncToGithubInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_sync_to_github', () => syncToGithubService(pool, config, input));
    },
  );
}
