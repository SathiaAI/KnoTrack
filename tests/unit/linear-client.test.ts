import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchLinearClient } from '../../src/linear/linear-client.js';

const KEY = 'lin_api_super_secret_value';
const OPTS = { timeoutMs: 8000, userAgent: 'knotrack-mcp-server' };
const TEAM = 'team-123';

function client() {
  return createFetchLinearClient(KEY, OPTS);
}

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
}
function resp(status: number, body: string, headers: Record<string, string> = {}): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  };
}
interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createFetchLinearClient — request shape', () => {
  it('createIssue sends issueCreate with the RAW Authorization header (no Bearer)', async () => {
    const fetchMock = vi.fn((_url: string, _init: FetchInit) =>
      Promise.resolve(
        resp(
          200,
          JSON.stringify({
            data: {
              issueCreate: { success: true, issue: { id: 'i1', identifier: 'ENG-1', url: 'u1' } },
            },
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' }, 's-done');
    expect(res).toEqual({ ok: true, value: { id: 'i1', identifier: 'ENG-1', url: 'u1' } });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.method).toBe('POST');
    // RAW key, not "Bearer <key>"
    expect(init.headers.Authorization).toBe(KEY);
    expect(init.headers.Authorization).not.toContain('Bearer');
    const parsed = JSON.parse(init.body);
    expect(parsed.query).toContain('issueCreate');
    expect(parsed.variables.input).toEqual({
      teamId: TEAM,
      title: 'T',
      description: 'D',
      stateId: 's-done',
    });
  });

  it('createIssue omits stateId when none is given', async () => {
    const fetchMock = vi.fn((_url: string, _init: FetchInit) =>
      Promise.resolve(
        resp(
          200,
          JSON.stringify({
            data: {
              issueCreate: { success: true, issue: { id: 'i1', identifier: 'E-1', url: 'u' } },
            },
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await client().createIssue(TEAM, { title: 'T', description: 'D' });
    const parsed = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(parsed.variables.input).not.toHaveProperty('stateId');
  });

  it('updateIssue sends issueUpdate at the issue id with stateId', async () => {
    const fetchMock = vi.fn((_url: string, _init: FetchInit) =>
      Promise.resolve(
        resp(
          200,
          JSON.stringify({
            data: {
              issueUpdate: { success: true, issue: { id: 'i1', identifier: 'E-1', url: 'u' } },
            },
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await client().updateIssue('i1', { title: 'T', description: 'D' }, 's-done');
    const parsed = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(parsed.query).toContain('issueUpdate');
    expect(parsed.variables).toEqual({
      id: 'i1',
      input: { title: 'T', description: 'D', stateId: 's-done' },
    });
  });
});

describe('createFetchLinearClient — error mapping', () => {
  it('maps a GraphQL 200-with-errors on a MUTATION to ambiguous (may have committed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(resp(200, JSON.stringify({ errors: [{ message: 'bad input' }] }))),
      ),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/^LINEAR_UNKNOWN_ERROR/);
      // A mutation's opaque GraphQL error is NOT proof no write happened.
      expect(res.ambiguous).toBe(true);
    }
  });

  it('maps a GraphQL 200-with-errors on a READ to non-ambiguous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(resp(200, JSON.stringify({ errors: [{ message: 'bad query' }] }))),
      ),
    );
    const res = await client().getWorkflowStates(TEAM);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.ambiguous).toBe(false);
  });

  it('keeps a 5xx AMBIGUOUS even when it carries a Retry-After header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(503, 'unavailable', { 'retry-after': '5' }))),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Must NOT be reclassified as a definitive rate-limit.
      expect(res.error).toMatch(/^LINEAR_UNKNOWN_ERROR/);
      expect(res.ambiguous).toBe(true);
    }
  });

  it('treats an explicit success:false mutation payload as DEFINITIVE (not ambiguous)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(200, JSON.stringify({ data: { issueCreate: { success: false, issue: null } } })),
        ),
      ),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.ambiguous).toBe(false);
  });

  it('maps a GraphQL entity-not-found error on a MUTATION to LINEAR_NOT_FOUND, ambiguous', async () => {
    // The NOT_FOUND prefix is still surfaced, but on a MUTATION a 200 GraphQL
    // error cannot prove no write occurred, so it stays ambiguous and the pending
    // link is kept for marker recovery, not cleared (CodeRabbit + panel, PR #25).
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(
            200,
            JSON.stringify({
              errors: [
                { message: 'Entity not found: Issue', extensions: { code: 'ENTITY_NOT_FOUND' } },
              ],
            }),
          ),
        ),
      ),
    );
    const res = await client().updateIssue('i1', { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/^LINEAR_NOT_FOUND/);
      expect(res.ambiguous).toBe(true);
    }
  });

  it('keeps mutation GraphQL rate-limit/auth/not-found AMBIGUOUS (200 cannot prove no write -> no duplicate)', async () => {
    // A 200 GraphQL error on a mutation is never proof of pre-execution rejection,
    // so the pending claim is kept (CodeRabbit + frontier panel, PR #25). The
    // prefix is still surfaced. HTTP-status forms of these stay definitive in
    // mapHttpError (see the HTTP 401/429 tests).
    for (const message of ['rate limited', 'authentication failed', 'Entity not found']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(resp(200, JSON.stringify({ errors: [{ message }] })))),
      );
      const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.ambiguous).toBe(true);
    }
  });

  it('keeps a mutation GraphQL OPAQUE error ambiguous (may have followed a side effect)', async () => {
    // The reconciliation: only a generic/unrecognized mutation error can legally
    // follow a write, so it alone stays ambiguous and keeps the pending link.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(200, JSON.stringify({ errors: [{ message: 'internal server error' }] })),
        ),
      ),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/^LINEAR_UNKNOWN_ERROR/);
      expect(res.ambiguous).toBe(true);
    }
  });

  it('leaves the same GraphQL errors NON-ambiguous on a read (a read writes nothing)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(resp(200, JSON.stringify({ errors: [{ message: 'Entity not found' }] }))),
      ),
    );
    const res = await client().getWorkflowStates(TEAM);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/^LINEAR_NOT_FOUND/);
      expect(res.ambiguous).toBe(false);
    }
  });

  it('redacts a boundary-straddling secret BEFORE truncation (HTTP body and GraphQL message)', async () => {
    // The secret sits so the 300-char cut lands mid-key. Redaction must run on
    // the FULL upstream text first, or a partial credential survives truncation
    // (Codex PR #25). 'lin_api_su' is the prefix an unredacted slice would keep.
    const pad = 'x'.repeat(290);
    // HTTP body path (5xx).
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(500, pad + KEY))),
    );
    let res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(KEY);
      expect(res.error).not.toContain('lin_api_su');
      expect(res.error).toContain('[REDACTED]');
    }
    // GraphQL message path (200 with errors).
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(200, JSON.stringify({ errors: [{ message: pad + KEY }] })))),
    );
    res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(KEY);
      expect(res.error).not.toContain('lin_api_su');
      expect(res.error).toContain('[REDACTED]');
    }
  });

  it('classifies a GraphQL error by a keyword PAST char 300 (classify full, truncate only detail)', async () => {
    // The identifying keyword sits after the 300-char cut; classification must run
    // on the full message so it is not misread as LINEAR_UNKNOWN_ERROR (Codex PR #25).
    const message = 'x'.repeat(320) + ' authentication failed';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(200, JSON.stringify({ errors: [{ message }] })))),
    );
    const res = await client().getWorkflowStates(TEAM);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^LINEAR_AUTH_FAILED/);
  });

  it('redacts the api_key from any returned error string', async () => {
    // An upstream body or a native-fetch exception could echo the key; it must
    // never reach tool output (GPT-6 adversarial review, invariant 3).
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(500, `upstream error, header was ${KEY} oops`))),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(KEY);
      expect(res.error).toContain('[REDACTED]');
    }
  });

  it('redacts the api_key from a thrown-exception error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error(`connect failed for Authorization: ${KEY}`))),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toContain(KEY);
  });

  it('maps a GraphQL rate-limit error to LINEAR_RATE_LIMITED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(
            200,
            JSON.stringify({
              errors: [{ message: 'ratelimited', extensions: { code: 'RATELIMITED' } }],
            }),
          ),
        ),
      ),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^LINEAR_RATE_LIMITED/);
  });

  it('maps HTTP 401 to LINEAR_AUTH_FAILED (not ambiguous)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(401, 'unauthorized'))),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/^LINEAR_AUTH_FAILED/);
      expect(res.ambiguous).toBe(false);
    }
  });

  it('maps HTTP 429 to LINEAR_RATE_LIMITED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(429, 'slow down'))),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^LINEAR_RATE_LIMITED/);
  });

  it('treats a 5xx on create as AMBIGUOUS (the write may have landed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(502, 'bad gateway'))),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.ambiguous).toBe(true);
  });

  it('maps an aborted (timed-out) request to LINEAR_TIMEOUT, ambiguous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        return Promise.reject(e);
      }),
    );
    const res = await client().createIssue(TEAM, { title: 'T', description: 'D' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/^LINEAR_TIMEOUT/);
      expect(res.ambiguous).toBe(true);
    }
  });
});

describe('createFetchLinearClient — reads', () => {
  it('findIssueByMarker returns only a node whose description contains the marker', async () => {
    const marker = '<!-- knotrack:track:abc -->';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(
            200,
            JSON.stringify({
              data: {
                issues: {
                  nodes: [
                    { id: 'x', identifier: 'E-1', url: 'ux', description: 'unrelated' },
                    { id: 'y', identifier: 'E-2', url: 'uy', description: `has ${marker}` },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            }),
          ),
        ),
      ),
    );
    const res = await client().findIssueByMarker(TEAM, marker);
    expect(res).toEqual({ ok: true, value: { id: 'y', identifier: 'E-2', url: 'uy' } });
  });

  it('findIssueByMarker reports an unconfirmed miss when more pages exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(
            200,
            JSON.stringify({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true } } } }),
          ),
        ),
      ),
    );
    const res = await client().findIssueByMarker(TEAM, 'm');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/could not confirm/);
      expect(res.ambiguous).toBe(true);
    }
  });

  it('getWorkflowStates parses the team states', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(
            200,
            JSON.stringify({
              data: {
                team: {
                  states: {
                    nodes: [
                      { id: 's1', name: 'Todo', type: 'unstarted', position: 1 },
                      { id: 's2', name: 'Done', type: 'completed', position: 3 },
                    ],
                  },
                },
              },
            }),
          ),
        ),
      ),
    );
    const res = await client().getWorkflowStates(TEAM);
    expect(res).toEqual({
      ok: true,
      value: [
        { id: 's1', name: 'Todo', type: 'unstarted', position: 1 },
        { id: 's2', name: 'Done', type: 'completed', position: 3 },
      ],
    });
  });

  it('getWorkflowStates returns LINEAR_NOT_FOUND for an unknown team', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(resp(200, JSON.stringify({ data: { team: null } })))),
    );
    const res = await client().getWorkflowStates(TEAM);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^LINEAR_NOT_FOUND/);
  });

  it('getIssueStateType returns the state type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(200, JSON.stringify({ data: { issue: { state: { type: 'completed' } } } })),
        ),
      ),
    );
    const res = await client().getIssueStateType('i1');
    expect(res).toEqual({ ok: true, value: 'completed' });
  });
});
