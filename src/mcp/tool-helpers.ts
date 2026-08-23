// Shared plumbing for wiring a tool's service function into an
// @modelcontextprotocol/sdk CallToolResult, per the error-envelope
// delivery rules in docs/TRD.md §3.1.
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

/** A "not yet implemented" stub result for the 9 tools out of scope for
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
