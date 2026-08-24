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

      // transport.handleRequest writes directly to the raw response, so
      // Fastify must be told to stop owning this reply *before* that call
      // runs — per Fastify's documented hijack contract, calling hijack()
      // only after an awaited handler settles is too late: a rejection
      // from handleRequest (e.g. thrown before it writes anything) would
      // otherwise leave Fastify still expecting to send its own response
      // on a reply that may already have had raw bytes written to it.
      reply.hijack();
      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        app.log.error({ err: error }, 'unhandled error in /mcp request handling');
        if (!reply.raw.headersSent && !reply.raw.writableEnded) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              error: {
                code: 'INTERNAL_ERROR',
                http_status_equivalent: 500,
                message: 'an unexpected error occurred',
              },
            }),
          );
        } else if (!reply.raw.writableEnded) {
          // Headers (e.g. an in-progress SSE stream) were already sent
          // before handleRequest rejected, so a fresh JSON error body can't
          // be written — but the response still has to be terminated, or
          // the client hangs on an open connection until its own timeout.
          reply.raw.end();
        }
      }
    },
  );
}
