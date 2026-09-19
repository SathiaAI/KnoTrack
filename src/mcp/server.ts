// Constructs the McpServer instance and registers the 14 canonical tools
// (docs/TRD.md §2). /health and /info are mounted as plain Fastify
// routes, not MCP tools — see src/server/health-route.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import type { Config } from '../config/env.js';
import { registerProjectTool } from './tools/register-project.js';
import { registerCreateTrackTool } from './tools/create-track.js';
import { registerCreateItemTool } from './tools/create-item.js';
import { registerGetProjectStatusTool } from './tools/get-project-status.js';
import { registerRecordSessionSummaryTool } from './tools/record-session-summary.js';
import { registerListTracksTool } from './tools/list-tracks.js';
import { registerGetTrackTool } from './tools/get-track.js';
import { registerGetNextStepsTool } from './tools/get-next-steps.js';
import { registerRenderRoadmapTool } from './tools/render-roadmap.js';
import { registerRecordDecisionTool } from './tools/record-decision.js';
import { registerUpdateItemStatusTool } from './tools/update-item-status.js';
import { registerCheckDriftTool } from './tools/check-drift.js';
import { registerSyncToGithubTool } from './tools/sync-to-github.js';
import { registerSyncToLinearTool } from './tools/sync-to-linear.js';

export interface Logger {
  error: (obj: unknown, msg?: string) => void;
}

export function buildMcpServer(pool: Pool, config: Config, logger: Logger): McpServer {
  const server = new McpServer({
    name: 'knotrack',
    version: '0.1.0',
  });

  // The 14 canonical tools (docs/TRD.md §2).
  registerProjectTool(server, pool, config, logger);
  registerGetProjectStatusTool(server, pool, config, logger);
  registerCreateTrackTool(server, pool, config, logger);
  registerCreateItemTool(server, pool, config, logger);
  registerRecordSessionSummaryTool(server, pool, config, logger);
  registerListTracksTool(server, pool, config, logger);
  registerGetTrackTool(server, pool, config, logger);
  registerGetNextStepsTool(server, pool, config, logger);
  registerRenderRoadmapTool(server, pool, config, logger);
  registerRecordDecisionTool(server, pool, config, logger);
  registerUpdateItemStatusTool(server, pool, config, logger);

  // The remaining 3: kt_check_drift returns an empty scan (no heuristics
  // configured until T6.4); the two sync tools validate the project/track
  // and adapter precondition (full external sync is T5.2/T5.3). See each
  // tool file and docs/PRD.md §4.11/§4.13/§4.14.
  registerCheckDriftTool(server, pool, config, logger);
  registerSyncToGithubTool(server, pool, config, logger);
  registerSyncToLinearTool(server, pool, config, logger);

  return server;
}
