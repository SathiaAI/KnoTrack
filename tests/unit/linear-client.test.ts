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
  it('maps a GraphQL 200-with-errors to LINEAR_UNKNOWN_ERROR, not ambiguous', async () => {
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
      expect(res.ambiguous).toBe(false);
    }
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
