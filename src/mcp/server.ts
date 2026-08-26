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
import { registerRecordDecisionTool } from './tools/record-decision.js';
import { registerUpdateItemStatusTool } from './tools/update-item-status.js';
import { registerStubTools } from './tools/stubs.js';

export interface Logger {
  error: (obj: unknown, msg?: string) => void;
}

export function buildMcpServer(pool: Pool, config: Config, logger: Logger): McpServer {
  const server = new McpServer({
    name: 'knotrack',
    version: '0.1.0',
  });

  // 9 fully implemented tools.
  registerProjectTool(server, pool, config, logger);
  registerGetProjectStatusTool(server, pool, config, logger);
  registerCreateTrackTool(server, pool, config, logger);
  registerCreateItemTool(server, pool, config, logger);
  registerRecordSessionSummaryTool(server, pool, config, logger);
  registerListTracksTool(server, pool, config, logger);
  registerGetTrackTool(server, pool, config, logger);
  registerRecordDecisionTool(server, pool, config, logger);
  registerUpdateItemStatusTool(server, pool, config, logger);

  // 5 stubs — registered so tools/list reflects the full 14-tool surface.
  registerStubTools(server);

  return server;
}
