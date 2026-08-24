// Full-stack tests through the real Fastify app (via .inject(), no open
// port needed) — covers auth failure/success and the closed-schema
// (additionalProperties: false) validation path, which lives at the
// transport layer rather than inside any single tool's service function.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFastify } from '../../src/server/fastify.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();
let app: FastifyInstance;

beforeAll(() => {
  app = buildFastify(pool, config, new Date());
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

function rpcCall(name: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function parseSseBody(body: string): unknown {
  // Streamable HTTP responses (when the client accepts text/event-stream)
  // come back as `event: message\ndata: <json>\n\n`. Pull the JSON out.
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`no SSE data line found in body: ${body}`);
  }
  return JSON.parse(dataLine.slice('data: '.length));
}

describe('GET /health pool isolation (adversarial-review security-1)', () => {
  it('positive: /health still responds promptly even when the main application pool is fully checked out', async () => {
    // Exhausts the exact shared resource the finding describes: hold every
    // connection the main pool can hand out, simulating either a flood of
    // /health itself (pre-fix) or ordinary MCP tool load. With a dedicated
    // health pool this cannot affect /health at all.
    const heldClients = await Promise.all(
      Array.from({ length: config.dbPoolMax }, () => pool.connect()),
    );
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', db: 'ok' });
    } finally {
      heldClients.forEach((c) => c.release());
    }
  });
});

describe('POST /mcp auth (TRD §4)', () => {
  it('negative: rejects before body parsing — an unauthenticated request with an unparseable JSON body still gets a clean 401, not a parse-error 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: '{not valid json',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', http_status_equivalent: 401 },
    });
  });

  it('negative: rejects a request with no Authorization header — 401 UNAUTHORIZED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', http_status_equivalent: 401 },
    });
  });

  it('negative: rejects a request with a wrong bearer token — 401 UNAUTHORIZED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer not-a-real-token',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('positive: accepts a request with a valid bearer token — tools/list returns all 14 tools', async () => {
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
    expect(response.statusCode).toBe(200);
    const body = parseSseBody(response.body) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools).toHaveLength(14);
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'kt_check_drift',
        'kt_create_item',
        'kt_create_track',
        'kt_get_next_steps',
        'kt_get_project_status',
        'kt_get_track',
        'kt_list_tracks',
        'kt_record_decision',
        'kt_record_session_summary',
        'kt_register_project',
        'kt_render_roadmap',
        'kt_sync_to_github',
        'kt_sync_to_linear',
        'kt_update_item_status',
      ].sort(),
    );
  });
});

describe('POST /mcp closed input schemas (TRD §3.0)', () => {
  // adversarial-review P1 (documented, not fixed — see
  // src/mcp/tool-helpers.ts's header comment and TRD §3.1's "known gap"
  // bullet): the SDK rejects this before KnoTrack's own tool handler /
  // runTool ever runs, so the response is *not* JSON.stringify of the
  // documented VALIDATION_ERROR envelope — it's the SDK's own plain-text
  // validation message. This assertion is intentionally loose (matches
  // either the SDK's wording or the field name) rather than asserting the
  // envelope shape, because the envelope shape is not what actually comes
  // back on this path.
  it('negative: an unknown property in a tool call is rejected as a validation failure', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.apiTokens[0]}`,
      },
      payload: rpcCall('kt_get_project_status', {
        project_id: '3f1a2b4c-9d3e-4a2f-8b21-6f0e2c9a1d55',
        unexpected_extra_field: true,
      }),
    });
    expect(response.statusCode).toBe(200); // TRD §3.1: tool-execution failures are HTTP 200
    const body = parseSseBody(response.body) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/unrecognized|unexpected_extra_field/i);
  });

  it('positive: a real tool call round-trips end to end over HTTP with auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.apiTokens[0]}`,
      },
      payload: rpcCall('kt_register_project', {
        name: 'HTTP smoke test',
        source_type: 'local',
        source_ref: `/tmp/${crypto.randomUUID()}`,
      }),
    });
    expect(response.statusCode).toBe(200);
    const body = parseSseBody(response.body) as {
      result: { structuredContent: { project_id: string }; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.project_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('stub tools respond with a clear not-implemented error rather than silently succeeding', async () => {
    const { project_id } = await registerProjectService(pool, config, {
      name: 'For stub test',
      source_type: 'local',
      source_ref: `/tmp/${crypto.randomUUID()}`,
      adapters: undefined,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.apiTokens[0]}`,
      },
      payload: rpcCall('kt_check_drift', { project_id }),
    });
    const body = parseSseBody(response.body) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    const envelope = JSON.parse(body.result.content[0]?.text ?? '{}') as {
      error: { message: string };
    };
    expect(envelope.error.message).toMatch(/not yet implemented/i);
  });

  // CodeRabbit raised a Critical finding that every tool handler casting
  // `rawArgs as SomeInputType` instead of calling `SomeInputSchema.parse`
  // meant Zod's `.default([])` on `kt_record_session_summary`'s
  // `files_touched`/`items_touched` would never actually run, so a call
  // omitting them would reach `Array.from(new Set(input.items_touched))`
  // with `undefined` and throw. Investigation (see src/mcp/tools/*.ts and
  // this pinned SDK version's server/mcp.js) found the handler was never
  // actually reachable with undefined fields in the first place: the SDK
  // (`McpServer.setToolRequestHandlers`) already runs
  // `this.validateToolInput(tool, request.params.arguments, ...)` — a real
  // `safeParseAsync` against the exact same Zod schema, defaults included
  // — and passes *that* parsed result into the handler, before the
  // handler's own body (and thus its cast) ever runs; a request missing
  // these fields never reaches `Array.from(new Set(undefined))` even
  // pre-fix. This test proves that end to end over the real HTTP/JSON-RPC
  // path. The `.parse()` calls this fix round added to every handler are
  // still correct defensive practice (and are exercised implicitly by
  // this same request), just not what was making this particular call
  // succeed.
  it('positive: kt_record_session_summary omitting files_touched/items_touched applies their [] defaults rather than throwing', async () => {
    const { project_id } = await registerProjectService(pool, config, {
      name: 'Defaults test',
      source_type: 'local',
      source_ref: `/tmp/${crypto.randomUUID()}`,
      adapters: undefined,
    });
    const { track_id } = await createTrackService(pool, config, {
      project_id,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.apiTokens[0]}`,
      },
      payload: rpcCall('kt_record_session_summary', {
        project_id,
        track_id,
        summary_text: 'Did the thing, no files/items listed.',
        // files_touched and items_touched deliberately omitted.
      }),
    });
    expect(response.statusCode).toBe(200);
    const body = parseSseBody(response.body) as {
      result: {
        isError?: boolean;
        structuredContent: { event_id: string; drift_flags_raised: unknown[] };
      };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.event_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.result.structuredContent.drift_flags_raised).toEqual([]);
  });
});
