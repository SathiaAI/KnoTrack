// GitHub REST client for kt_sync_to_github (docs/PRD.md §4.13, T5.2).
//
// Deliberately a thin native-fetch wrapper, not @octokit/* — the design
// panel (2026-09-19, unanimous) chose the smallest auditable dependency
// surface for a self-hosted server, since this is two write endpoints plus
// one recovery search. Every method makes exactly one HTTP call and
// returns a discriminated result; it NEVER throws for an HTTP-level outcome
// and NEVER logs or echoes the token.
//
// Operational failures are mapped to the fixed PRD §4.13 prefixes
// (GITHUB_AUTH_FAILED / GITHUB_NOT_FOUND / GITHUB_RATE_LIMITED /
// GITHUB_TIMEOUT / GITHUB_UNKNOWN_ERROR). `ambiguous` tells the caller
// whether a create request may have reached GitHub and created an issue
// despite the failure (timeout / 5xx / network) — the caller uses it to
// decide whether a durable `pending` link is safe to clear.

const GITHUB_API = 'https://api.github.com';

export interface GitHubIssuePayload {
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason?: 'completed';
}

export interface GitHubIssueRef {
  /** repo-scoped issue number, as a string (PATCH targets this, not the URL). */
  number: string;
  html_url: string;
}

export type GitHubResult<T> =
  { ok: true; value: T } | { ok: false; error: string; ambiguous: boolean };

export interface GitHubClient {
  /** POST /repos/{repo}/issues — creates an (open) issue with title+body. */
  createIssue(repo: string, payload: GitHubIssuePayload): Promise<GitHubResult<GitHubIssueRef>>;
  /** PATCH /repos/{repo}/issues/{number} — reconciles title/body/state. */
  updateIssue(
    repo: string,
    issueNumber: string,
    payload: GitHubIssuePayload,
  ): Promise<GitHubResult<GitHubIssueRef>>;
  /** Recovery-only: find an existing issue whose body carries `marker`.
   * Returns null when none is found. */
  findIssueByMarker(repo: string, marker: string): Promise<GitHubResult<GitHubIssueRef | null>>;
}

export interface GitHubClientOptions {
  timeoutMs: number;
  userAgent: string;
}

export type GitHubClientFactory = (token: string, opts: GitHubClientOptions) => GitHubClient;

function isRateLimited(status: number, headers: Headers, bodyText: string): boolean {
  if (status === 429) return true;
  if (status === 403) {
    if (headers.get('retry-after')) return true;
    if (headers.get('x-ratelimit-remaining') === '0') return true;
    // Secondary rate limits return 403 with a body message rather than the
    // primary-limit headers — treat those as rate-limited (retryable), not
    // as an auth failure.
    if (/secondary rate limit|\brate limit\b/i.test(bodyText)) return true;
  }
  return false;
}

/** Maps a completed HTTP response (non-2xx) to a prefixed error string plus
 * the ambiguity flag. A 4xx means GitHub rejected the request, so a create
 * that got one did NOT create an issue (ambiguous=false). A 5xx is
 * different: GitHub may have created the issue and then failed to respond
 * cleanly, so a create that got a 5xx is AMBIGUOUS — the caller must keep
 * its pending link for marker recovery rather than recreating. Timeouts and
 * network errors are handled as ambiguous by the caller's catch. */
function mapErrorResponse(
  status: number,
  headers: Headers,
  bodyText: string,
): {
  error: string;
  ambiguous: boolean;
} {
  const detail = bodyText.slice(0, 300).replace(/\s+/g, ' ').trim();
  if (status === 401)
    return { error: `GITHUB_AUTH_FAILED: ${detail || 'unauthorized'}`, ambiguous: false };
  if (isRateLimited(status, headers, bodyText))
    return { error: `GITHUB_RATE_LIMITED: ${detail || 'rate limit exceeded'}`, ambiguous: false };
  if (status === 403)
    return { error: `GITHUB_AUTH_FAILED: ${detail || 'forbidden'}`, ambiguous: false };
  if (status === 404)
    return { error: `GITHUB_NOT_FOUND: ${detail || 'not found'}`, ambiguous: false };
  // No dedicated validation prefix in the PRD's closed set; 422 and any
  // other status fold into UNKNOWN with GitHub's own message. 5xx is
  // ambiguous for the create path (the write may have landed server-side).
  return {
    error: `GITHUB_UNKNOWN_ERROR: HTTP ${status}${detail ? `: ${detail}` : ''}`,
    ambiguous: status >= 500,
  };
}

function mapThrown(err: unknown): { error: string; ambiguous: boolean } {
  if (err instanceof Error && err.name === 'AbortError') {
    return { error: 'GITHUB_TIMEOUT: request exceeded the configured timeout', ambiguous: true };
  }
  const msg = err instanceof Error ? err.message : String(err);
  // A request that never got a response may still have been received and
  // acted on by GitHub -> ambiguous for the create path.
  return { error: `GITHUB_UNKNOWN_ERROR: ${msg}`, ambiguous: true };
}

export function createFetchGitHubClient(token: string, opts: GitHubClientOptions): GitHubClient {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': opts.userAgent,
    'Content-Type': 'application/json',
  };

  async function send(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    jsonBody?: unknown,
  ): Promise<GitHubResult<{ status: number; body: unknown }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) {
        let body: unknown = undefined;
        try {
          body = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
          return {
            ok: false,
            error: 'GITHUB_UNKNOWN_ERROR: malformed JSON in GitHub response',
            // The status was 2xx, so a create may already have succeeded —
            // keep it ambiguous so the caller retains its pending link for
            // recovery instead of clearing and recreating a duplicate.
            ambiguous: true,
          };
        }
        return { ok: true, value: { status: res.status, body } };
      }
      const mapped = mapErrorResponse(res.status, res.headers, text);
      return { ok: false, error: mapped.error, ambiguous: mapped.ambiguous };
    } catch (err) {
      const mapped = mapThrown(err);
      return { ok: false, error: mapped.error, ambiguous: mapped.ambiguous };
    } finally {
      clearTimeout(timer);
    }
  }

  function toRef(body: unknown): GitHubIssueRef | null {
    if (body === null || typeof body !== 'object') return null;
    const rec = body as Record<string, unknown>;
    const num = rec.number;
    const url = rec.html_url;
    if (typeof num !== 'number' || typeof url !== 'string') return null;
    return { number: String(num), html_url: url };
  }

  return {
    async createIssue(repo, payload) {
      const res = await send('POST', `${GITHUB_API}/repos/${repo}/issues`, {
        title: payload.title,
        body: payload.body,
      });
      if (!res.ok) return res;
      const ref = toRef(res.value.body);
      if (!ref)
        return {
          ok: false,
          error: 'GITHUB_UNKNOWN_ERROR: created issue response missing number/html_url',
          // The issue was in fact created (2xx); treat as ambiguous so the
          // caller keeps the pending link for marker recovery rather than
          // recreating.
          ambiguous: true,
        };
      return { ok: true, value: ref };
    },

    async updateIssue(repo, issueNumber, payload) {
      const patch: Record<string, unknown> = {
        title: payload.title,
        body: payload.body,
        state: payload.state,
      };
      if (payload.state_reason) patch.state_reason = payload.state_reason;
      const res = await send('PATCH', `${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, patch);
      if (!res.ok) return res;
      const ref = toRef(res.value.body);
      if (!ref)
        return {
          ok: false,
          error: 'GITHUB_UNKNOWN_ERROR: updated issue response missing number/html_url',
          ambiguous: false,
        };
      return { ok: true, value: ref };
    },

    async findIssueByMarker(repo, marker) {
      // Recovery-only. `type:issue` excludes pull requests (the search API
      // returns both). GitHub search is eventually consistent AND can return
      // incomplete results, so a null is never immediate proof no issue
      // exists — the caller pairs it with the pending link's age, and an
      // INCOMPLETE search is reported as an error so recovery does not
      // recreate on a false miss.
      const q = encodeURIComponent(`repo:${repo} type:issue in:body "${marker}"`);
      const res = await send('GET', `${GITHUB_API}/search/issues?q=${q}&per_page=20`);
      if (!res.ok) return res;
      const body = (res.value.body ?? {}) as Record<string, unknown>;
      const items = Array.isArray(body.items) ? (body.items as unknown[]) : [];
      for (const item of items) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          if (typeof rec.body === 'string' && rec.body.includes(marker)) {
            const ref = toRef(item);
            if (ref) return { ok: true, value: ref };
          }
        }
      }
      // No match found. Only trust that as "no issue exists" if the search
      // was complete; otherwise report it unconfirmed so the caller retries
      // instead of recreating a possibly-existing issue.
      const incomplete = body.incomplete_results === true;
      const total = typeof body.total_count === 'number' ? body.total_count : items.length;
      if (incomplete || total > items.length) {
        return {
          ok: false,
          error:
            'GITHUB_UNKNOWN_ERROR: issue search returned incomplete results; could not confirm',
          ambiguous: true,
        };
      }
      return { ok: true, value: null };
    },
  };
}
