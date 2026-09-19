import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchGitHubClient } from '../../src/github/github-client.js';

const TOKEN = 'ghp_super_secret_value';
const OPTS = { timeoutMs: 8000, userAgent: 'knotrack-mcp-server' };

function client() {
  return createFetchGitHubClient(TOKEN, OPTS);
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

describe('createFetchGitHubClient — request shape', () => {
  it('createIssue POSTs title+body with the correct headers and URL', async () => {
    const fetchMock = vi.fn((_url: string, _init: FetchInit) =>
      Promise.resolve(
        resp(201, JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/issues/7' })),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await client().createIssue('o/r', { title: 'T', body: 'B', state: 'open' });
    expect(res).toEqual({
      ok: true,
      value: { number: '7', html_url: 'https://github.com/o/r/issues/7' },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/o/r/issues');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(init.headers['User-Agent']).toBe('knotrack-mcp-server');
    expect(JSON.parse(init.body)).toEqual({ title: 'T', body: 'B' });
  });

  it('updateIssue PATCHes title+body+state(+state_reason) at the numbered URL', async () => {
    const fetchMock = vi.fn((_url: string, _init: FetchInit) =>
      Promise.resolve(
        resp(200, JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/issues/7' })),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await client().updateIssue('o/r', '7', {
      title: 'T',
      body: 'B',
      state: 'closed',
      state_reason: 'completed',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/o/r/issues/7');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({
      title: 'T',
      body: 'B',
      state: 'closed',
      state_reason: 'completed',
    });
  });

  it('findIssueByMarker searches and returns only a body that actually contains the marker', async () => {
    const marker = '<!-- knotrack:track:abc -->';
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        resp(
          200,
          JSON.stringify({
            items: [
              { number: 1, html_url: 'u1', body: 'unrelated' },
              { number: 2, html_url: 'u2', body: `has ${marker} inside` },
            ],
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await client().findIssueByMarker('o/r', marker);
    expect(res).toEqual({ ok: true, value: { number: '2', html_url: 'u2' } });
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain('/search/issues?q=');
    // excludes pull requests
    expect(decodeURIComponent(url)).toContain('type:issue');
  });

  it('findIssueByMarker returns null when a COMPLETE search finds no match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(
            200,
            JSON.stringify({
              total_count: 1,
              incomplete_results: false,
              items: [{ number: 1, html_url: 'u', body: 'nope' }],
            }),
          ),
        ),
      ),
    );
    const res = await client().findIssueByMarker('o/r', '<!-- knotrack:track:zzz -->');
    expect(res).toEqual({ ok: true, value: null });
  });

  it('findIssueByMarker reports unconfirmed (not null) when the search is incomplete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(200, JSON.stringify({ total_count: 0, incomplete_results: true, items: [] })),
        ),
      ),
    );
    const res = await client().findIssueByMarker('o/r', '<!-- knotrack:track:zzz -->');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.ambiguous).toBe(true);
  });

  it('findIssueByMarker reports unconfirmed when more matches exist than were fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(
            200,
            JSON.stringify({
              total_count: 50,
              incomplete_results: false,
              items: [{ number: 1, html_url: 'u', body: 'nope' }],
            }),
          ),
        ),
      ),
    );
    const res = await client().findIssueByMarker('o/r', '<!-- knotrack:track:zzz -->');
    expect(res.ok).toBe(false);
  });
});

describe('createFetchGitHubClient — error mapping (PRD §4.13 prefixes)', () => {
  const cases: Array<[number, Record<string, string>, string, boolean]> = [
    // [status, headers, prefix, ambiguous]
    [401, {}, 'GITHUB_AUTH_FAILED', false],
    [403, { 'x-ratelimit-remaining': '0' }, 'GITHUB_RATE_LIMITED', false],
    [403, { 'retry-after': '60' }, 'GITHUB_RATE_LIMITED', false],
    [403, {}, 'GITHUB_AUTH_FAILED', false],
    [404, {}, 'GITHUB_NOT_FOUND', false],
    [422, {}, 'GITHUB_UNKNOWN_ERROR', false],
    [429, {}, 'GITHUB_RATE_LIMITED', false],
    // 5xx is ambiguous: the create may have landed server-side.
    [500, {}, 'GITHUB_UNKNOWN_ERROR', true],
    [503, {}, 'GITHUB_UNKNOWN_ERROR', true],
  ];

  for (const [status, headers, prefix, ambiguous] of cases) {
    it(`maps HTTP ${status} -> ${prefix} (ambiguous=${ambiguous}, no token leak)`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(resp(status, JSON.stringify({ message: 'gh says no' }), headers)),
        ),
      );
      const res = await client().createIssue('o/r', { title: 'T', body: 'B', state: 'open' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.startsWith(prefix)).toBe(true);
        expect(res.ambiguous).toBe(ambiguous);
        expect(res.error).not.toContain(TOKEN);
      }
    });
  }

  it('maps a 403 secondary-rate-limit body -> GITHUB_RATE_LIMITED (not auth failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(403, JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {}),
        ),
      ),
    );
    const res = await client().createIssue('o/r', { title: 'T', body: 'B', state: 'open' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith('GITHUB_RATE_LIMITED')).toBe(true);
  });

  it('maps an AbortError (timeout) -> GITHUB_TIMEOUT with ambiguous=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
    );
    const res = await client().createIssue('o/r', { title: 'T', body: 'B', state: 'open' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.startsWith('GITHUB_TIMEOUT')).toBe(true);
      expect(res.ambiguous).toBe(true);
    }
  });

  it('maps a network throw -> GITHUB_UNKNOWN_ERROR with ambiguous=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNRESET'))),
    );
    const res = await client().createIssue('o/r', { title: 'T', body: 'B', state: 'open' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.startsWith('GITHUB_UNKNOWN_ERROR')).toBe(true);
      expect(res.ambiguous).toBe(true);
    }
  });
});
