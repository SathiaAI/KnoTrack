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
    expect(fetchMock.mock.calls[0]![0]).toContain('/search/issues?q=');
  });

  it('findIssueByMarker returns null when no body matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          resp(200, JSON.stringify({ items: [{ number: 1, html_url: 'u', body: 'nope' }] })),
        ),
      ),
    );
    const res = await client().findIssueByMarker('o/r', '<!-- knotrack:track:zzz -->');
    expect(res).toEqual({ ok: true, value: null });
  });
});

describe('createFetchGitHubClient — error mapping (PRD §4.13 prefixes)', () => {
  const cases: Array<[number, Record<string, string>, string]> = [
    [401, {}, 'GITHUB_AUTH_FAILED'],
    [403, { 'x-ratelimit-remaining': '0' }, 'GITHUB_RATE_LIMITED'],
    [403, { 'retry-after': '60' }, 'GITHUB_RATE_LIMITED'],
    [403, {}, 'GITHUB_AUTH_FAILED'],
    [404, {}, 'GITHUB_NOT_FOUND'],
    [422, {}, 'GITHUB_UNKNOWN_ERROR'],
    [429, {}, 'GITHUB_RATE_LIMITED'],
    [500, {}, 'GITHUB_UNKNOWN_ERROR'],
  ];

  for (const [status, headers, prefix] of cases) {
    it(`maps HTTP ${status} -> ${prefix} (ambiguous=false, no token leak)`, async () => {
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
        expect(res.ambiguous).toBe(false);
        expect(res.error).not.toContain(TOKEN);
      }
    });
  }

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
