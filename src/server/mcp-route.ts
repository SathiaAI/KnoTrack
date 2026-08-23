// Mounts POST /mcp using StreamableHTTPServerTransport in stateless mode
// (docs/TRD.md §0 / §1 — MCP protocol revision 2026-07-28 has no
// initialize/initialized handshake and no Mcp-Session-Id).
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config/env.js';
import { buildMcpServer, type Logger } from '../mcp/server.js';
import { createAuthPreHandler } from './auth.js';

export function registerMcpRoute(app: FastifyInstance, pool: Pool, config: Config): void {
  const logger: Logger = {
    error: (obj, msg) => app.log.error(obj, msg),
  };

  app.post(
    '/mcp',
    // adversarial-review security-2: Fastify's lifecycle runs preParsing/
    // body-parsing BEFORE preHandler, so an auth check registered as
    // preHandler still pays the cost of parsing an unauthenticated
    // request's JSON body (up to the default 1MiB bodyLimit) before
    // rejecting it. onRequest runs first, before the body is read at all,
    // so an invalid/missing bearer token is rejected without ever parsing
    // the payload. createAuthPreHandler only reads request.headers, so it
    // has no dependency on the parsed body and is safe to run this early.
    { onRequest: createAuthPreHandler(config.apiTokens) },
    async (request, reply) => {
      // A fresh McpServer + transport per request keeps this genuinely
      // stateless: no session state, no shared in-flight request-id
      // bookkeeping across concurrent calls. Tool registration itself is
      // cheap (just populates lookup tables against the shared pool/config
      // singletons), so this has no real per-request cost.
      const server = buildMcpServer(pool, config, logger);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      reply.raw.on('close', () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });

      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      // transport.handleRequest writes directly to the raw response; tell
      // Fastify not to also send a reply.
      reply.hijack();
    },
  );
}
