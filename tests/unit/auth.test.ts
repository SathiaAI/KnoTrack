import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createAuthPreHandler, isAuthorizedToken } from '../../src/server/auth.js';

describe('isAuthorizedToken (TRD §4)', () => {
  const configured = ['kt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'kt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'];

  it('authorizes a token matching any entry in the pool', () => {
    expect(isAuthorizedToken(configured[0]!, configured)).toBe(true);
    expect(isAuthorizedToken(configured[1]!, configured)).toBe(true);
  });

  it('rejects a token matching none of the pool', () => {
    expect(isAuthorizedToken('kt_totally_unknown_token', configured)).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isAuthorizedToken('', configured)).toBe(false);
  });

  it('handles tokens of different lengths without throwing', () => {
    expect(() => isAuthorizedToken('short', configured)).not.toThrow();
    expect(isAuthorizedToken('short', configured)).toBe(false);
  });
});

// The preHandler hook itself (header parsing, 401 short-circuits, calling
// `done()` on success) is otherwise only exercised indirectly through the
// integration suite's real HTTP requests. That left it with near-zero
// direct unit coverage — flagged by Stryker mutation testing on this
// security-critical path (auth.ts scored 18.75% under unit-only scope
// vs. 60%+ elsewhere). These tests close that gap directly.
describe('createAuthPreHandler (TRD §4)', () => {
  const configured = ['kt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];

  // Returns the mock fns alongside the typed reply so assertions read from
  // plain vi.fn() references (`code`/`send`) rather than `reply.code` /
  // `reply.send` — going through the typed FastifyReply interface there
  // trips @typescript-eslint/unbound-method, since the linter can't see
  // through the `as unknown as FastifyReply` cast to know they're mocks.
  function fakeReply(): {
    reply: FastifyReply;
    code: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  } {
    const code = vi.fn();
    const send = vi.fn();
    const reply = { code, send } as unknown as FastifyReply;
    code.mockReturnValue(reply);
    return { reply, code, send };
  }

  function fakeRequest(authorization?: string): FastifyRequest {
    return { headers: { authorization } } as unknown as FastifyRequest;
  }

  const UNAUTHORIZED_BODY = {
    error: {
      code: 'UNAUTHORIZED',
      http_status_equivalent: 401,
      message: 'missing or invalid bearer token',
    },
  };

  it('rejects a missing Authorization header with 401 and the error envelope', () => {
    const handler = createAuthPreHandler(configured);
    const { reply, code, send } = fakeReply();
    const done = vi.fn();
    handler(fakeRequest(undefined), reply, done);
    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith(UNAUTHORIZED_BODY);
    expect(done).not.toHaveBeenCalled();
  });

  it('rejects a header missing the "Bearer " scheme with 401', () => {
    const handler = createAuthPreHandler(configured);
    const { reply, code, send } = fakeReply();
    const done = vi.fn();
    handler(fakeRequest(configured[0]), reply, done);
    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith(UNAUTHORIZED_BODY);
    expect(done).not.toHaveBeenCalled();
  });

  it('rejects a lowercase "bearer" scheme (case-sensitive check) with 401', () => {
    const handler = createAuthPreHandler(configured);
    const { reply, code } = fakeReply();
    const done = vi.fn();
    handler(fakeRequest(`bearer ${configured[0]}`), reply, done);
    expect(code).toHaveBeenCalledWith(401);
    expect(done).not.toHaveBeenCalled();
  });

  it('rejects an empty token after "Bearer " with 401', () => {
    const handler = createAuthPreHandler(configured);
    const { reply, code } = fakeReply();
    const done = vi.fn();
    handler(fakeRequest('Bearer '), reply, done);
    expect(code).toHaveBeenCalledWith(401);
    expect(done).not.toHaveBeenCalled();
  });

  it('rejects a token containing a space with 401', () => {
    const handler = createAuthPreHandler(configured);
    const { reply, code } = fakeReply();
    const done = vi.fn();
    handler(fakeRequest('Bearer has a space'), reply, done);
    expect(code).toHaveBeenCalledWith(401);
    expect(done).not.toHaveBeenCalled();
  });

  it('rejects a well-formed but unauthorized token with 401', () => {
    const handler = createAuthPreHandler(configured);
    const { reply, code, send } = fakeReply();
    const done = vi.fn();
    handler(fakeRequest('Bearer kt_totally_unknown_token'), reply, done);
    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith(UNAUTHORIZED_BODY);
    expect(done).not.toHaveBeenCalled();
  });

  it('calls done() with no reply for a valid Bearer token', () => {
    const handler = createAuthPreHandler(configured);
    const { reply, code, send } = fakeReply();
    const done = vi.fn();
    handler(fakeRequest(`Bearer ${configured[0]}`), reply, done);
    expect(done).toHaveBeenCalledWith();
    expect(code).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
