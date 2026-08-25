// adversarial-review test_quality-2 (docs/ROADMAP.md T9.x): runTool's error
// envelope shape and generic-error redaction had no direct unit test — only
// indirect coverage via a real KtError-throwing service
// (register-project.test.ts's "adapter-storage failure" case). This exercises
// runTool itself, in isolation, against both a KtError and a plain Error.
import { describe, expect, it } from 'vitest';
import { runTool } from '../../src/mcp/tool-helpers.js';
import { notFound } from '../../src/mcp/errors.js';

describe('runTool', () => {
  it('positive: a successful fn returns both text content and structuredContent, no isError', async () => {
    const result = await runTool(console, 'kt_fake_tool', () =>
      Promise.resolve({ ok: true, count: 3 }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true, count: 3 });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ ok: true, count: 3 }) },
    ]);
  });

  it('negative: a thrown KtError is packaged as its exact §3.1 envelope, isError true', async () => {
    const result = await runTool(console, 'kt_fake_tool', () =>
      Promise.reject(notFound('thing not found', { thing_id: 'abc' })),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed).toEqual({
      error: {
        code: 'NOT_FOUND',
        http_status_equivalent: 404,
        message: 'thing not found',
        details: { thing_id: 'abc' },
      },
    });
  });

  it('negative: a non-KtError is logged server-side and redacted to a generic INTERNAL_ERROR envelope', async () => {
    const loggedErrors: unknown[] = [];
    const spyLogger = { error: (obj: unknown) => loggedErrors.push(obj) };
    const rawError = new Error('raw driver failure: password authentication failed');

    const result = await runTool(spyLogger, 'kt_fake_tool', () => Promise.reject(rawError));

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}');
    expect(parsed).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        http_status_equivalent: 500,
        message: 'an unexpected error occurred',
      },
    });
    // The raw error text must never reach the client-facing envelope...
    expect(JSON.stringify(parsed)).not.toMatch(/password authentication failed/);
    // ...but it must not be silently swallowed either — it goes to the
    // server-side logger, tagged with the tool name that threw.
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toMatchObject({ err: rawError, tool: 'kt_fake_tool' });
  });
});
