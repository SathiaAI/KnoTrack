// Shared plumbing for wiring a tool's service function into an
// @modelcontextprotocol/sdk CallToolResult, per the error-envelope
// delivery rules in docs/TRD.md §3.1.
//
// KNOWN LIMITATION (adversarial-review P1, confirmed real, not fixed —
// documented per this build's "don't guess at a fix that doesn't actually
// work" rule): `runTool` below only ever sees a request that already
// reached a tool's handler function. But `@modelcontextprotocol/sdk`
// (server/mcp.js's `setToolRequestHandlers`) validates `tools/call`
// arguments against the tool's `inputSchema` *before* calling that
// handler at all — a malformed call (unknown property, invalid UUID, a
// missing required field) never runs `fn()` here, so it never gets
// wrapped in the documented VALIDATION_ERROR envelope. Instead the SDK
// catches its own `McpError(InvalidParams, ...)` and returns
// `{ isError: true, content: [{ text: "Input validation error: ..." }] }`
// — an isError result, per MCP convention, but with the SDK's own plain-
// text message as `content[0].text`, not `JSON.stringify` of this
// module's envelope. A client parsing that text as JSON expecting
// `{ error: { code: 'VALIDATION_ERROR', ... } }` gets something else.
//
// This can't be intercepted per-tool: `inputSchema` validation is baked
// into the one `CallToolRequestSchema` handler `McpServer` installs
// internally for every registered tool, with no per-tool hook and no
// public option to reformat its error output. The only ways to change it
// are either of these, and both cost more than they're worth for what is,
// in effect, malformed-request handling for a spec-compliant client:
//   1. Register every tool with no `inputSchema` and hand-validate inside
//      each handler instead — but the SDK also derives `tools/list`'s
//      published JSON Schema from `inputSchema` (this repo's whole reason
//      for having zod schemas as "the single source of truth", per
//      src/schemas/tools.ts's header comment); dropping it would silently
//      turn every one of the 14 tools' advertised schemas into an empty
//      object, trading one bug for a bigger one.
//   2. Call `server.server.setRequestHandler(CallToolRequestSchema, ...)`
//      again after registration to install a replacement dispatcher —
//      `Protocol.setRequestHandler` is public API and does allow this,
//      but doing it correctly means reimplementing everything the SDK's
//      own dispatcher currently does (task-support handling, output-schema
//      validation, disabled-tool checks, tool lookup) against its
//      internal, undocumented `_registeredTools` map — forking a chunk of
//      SDK-internal behavior to fix one error-formatting edge case, and
//      fragile to break silently on an SDK upgrade.
// tests/integration/http.test.ts's closed-schema test asserts against the
// SDK's real (non-enveloped) text, not the documented envelope, for this
// exact reason.
import { KtError, internalError } from './errors.js';

export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Wraps a service call: success returns the JSON-serialized result (both
 * as text content and structuredContent); a thrown KtError is packaged as
 * the exact §3.1 envelope with isError: true; any other thrown error is
 * logged server-side (never leaking driver text to the client) and
 * surfaced as a generic INTERNAL_ERROR envelope.
 */
export async function runTool<T extends Record<string, unknown>>(
  logger: { error: (obj: unknown, msg?: string) => void },
  toolName: string,
  fn: () => Promise<T>,
): Promise<ToolTextResult> {
  try {
    const result = await fn();
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    if (error instanceof KtError) {
      return {
        content: [{ type: 'text', text: JSON.stringify(error.toEnvelope()) }],
        isError: true,
      };
    }
    logger.error({ err: error, tool: toolName }, 'unhandled error in tool handler');
    const envelope = internalError('an unexpected error occurred').toEnvelope();
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      isError: true,
    };
  }
}

/** A "not yet implemented" stub result for the 5 tools out of scope for
 * this build (see the tool table in docs/TRD.md §2 / the repo layout). */
export function notImplementedResult(toolName: string): ToolTextResult {
  const envelope = {
    error: {
      code: 'INTERNAL_ERROR' as const,
      http_status_equivalent: 500,
      message: `${toolName} is registered but not yet implemented in this build`,
      details: { tool: toolName },
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: true,
  };
}
