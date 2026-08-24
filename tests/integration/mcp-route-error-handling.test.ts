// CodeRabbit re-review: registerMcpRoute's catch block only terminated the
// response when `!reply.raw.headersSent && !reply.raw.writableEnded` (the
// branch that writes a fresh 500 JSON body). If `transport.handleRequest`
// had already written headers (e.g. it started streaming an SSE response)
// before rejecting, neither that branch nor anything else ran — the
// response was left open and the client would hang until its own timeout.
//
// This subclasses the real StreamableHTTPServerTransport, overriding only
// `handleRequest` to write headers/a partial body and then reject — the
// exact "headers already sent, then an error" shape the fix targets — so
// the rest of registerMcpRoute's real connect/hijack/catch logic runs
// unmodified.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getTestConfig, getTestPool, closeTestPool } from './helpers.js';

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js')>();

  class HeadersSentThenThrowsTransport extends actual.StreamableHTTPServerTransport {
    override handleRequest(
      _req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
      _parsedBody?: unknown,
    ): Promise<void> {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: {}\n\n');
      return Promise.reject(new Error('simulated failure after headers were already sent'));
    }
  }

  return { ...actual, StreamableHTTPServerTransport: HeadersSentThenThrowsTransport };
});

const pool = getTestPool();
const config = getTestConfig();
let app: FastifyInstance;

beforeAll(async () => {
  // Imported after the mock above is registered so registerMcpRoute picks
  // up the throwing transport subclass.
  const { buildFastify } = await import('../../src/server/fastify.js');
  app = buildFastify(pool, config, new Date());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

describe('POST /mcp error handling when headers were already sent (CodeRabbit re-review)', () => {
  it('ends the response instead of hanging when handleRequest throws after writing headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.apiTokens[0]}`,
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    // Before the fix, this request would never resolve (the response was
    // never ended) and this test would fail on vitest's testTimeout
    // instead of reaching any assertion below.
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('event: message\ndata: {}\n\n');
    expect(response.raw.res.writableEnded).toBe(true);
  });
});
