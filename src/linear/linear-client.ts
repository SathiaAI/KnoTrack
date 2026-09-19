// Linear GraphQL client for kt_sync_to_linear (docs/PRD.md §4.14, T5.3).
//
// Mirrors src/github/github-client.ts by design: a thin native-fetch
// wrapper (no @linear/sdk), one HTTP call per method, a discriminated
// result that NEVER throws for an API-level outcome and NEVER logs or
// echoes the api_key. The frontier panel (2026-09-19) chose the same
// smallest-auditable-dependency approach as GitHub for this self-hosted
// server.
//
// Linear differences handled here:
//   - Transport is GraphQL: one endpoint, POST { query, variables }. A
//     GraphQL request can return HTTP 200 with a top-level `errors` array
//     (the mutation was REJECTED, nothing was written) — that is mapped to
//     {ok:false} exactly like an HTTP error, with ambiguous=false because a
//     rejected GraphQL mutation is transactional (no partial write).
//   - Auth header is the raw api_key ("Authorization: <key>"), NOT
//     "Bearer <key>" (that form is only for OAuth access tokens).
//   - There is no open/closed; a workflow state (stateId) is resolved by
//     the caller and passed in. This client only sets what it is given.
//
// Operational failures map to fixed prefixes
// (LINEAR_AUTH_FAILED / LINEAR_NOT_FOUND / LINEAR_RATE_LIMITED /
// LINEAR_TIMEOUT / LINEAR_UNKNOWN_ERROR). `ambiguous` tells the caller
// whether a create mutation may have reached Linear despite the failure
// (timeout / 5xx / network / malformed-2xx) so it can keep a durable
// `pending` link for marker recovery instead of recreating a duplicate.

const LINEAR_API = 'https://api.linear.app/graphql';

export interface LinearIssuePayload {
  title: string;
  description: string;
}

export interface LinearIssueRef {
  /** Linear issue UUID — issueUpdate targets this. */
  id: string;
  /** Human identifier, e.g. "ENG-123" (informational). */
  identifier: string;
  url: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  /** backlog | unstarted | started | completed | canceled */
  type: string;
  position: number;
}

export type LinearResult<T> =
  { ok: true; value: T } | { ok: false; error: string; ambiguous: boolean };

export interface LinearClient {
  /** issueCreate — creates an issue in `teamId`; sets `stateId` when given. */
  createIssue(
    teamId: string,
    payload: LinearIssuePayload,
    stateId?: string,
  ): Promise<LinearResult<LinearIssueRef>>;
  /** issueUpdate — reconciles title/description (and stateId when given). */
  updateIssue(
    issueId: string,
    payload: LinearIssuePayload,
    stateId?: string,
  ): Promise<LinearResult<LinearIssueRef>>;
  /** Recovery-only: find an existing issue in `teamId` whose description
   * carries `marker`. Returns null when none is found. */
  findIssueByMarker(teamId: string, marker: string): Promise<LinearResult<LinearIssueRef | null>>;
  /** The team's workflow states, for the state resolver. */
  getWorkflowStates(teamId: string): Promise<LinearResult<LinearWorkflowState[]>>;
  /** The current workflow-state TYPE of an issue (e.g. 'completed'), used to
   * decide whether a reopen should move it backward. Null when the issue or
   * its state is absent. */
  getIssueStateType(issueId: string): Promise<LinearResult<string | null>>;
}

export interface LinearClientOptions {
  timeoutMs: number;
  userAgent: string;
}

export type LinearClientFactory = (apiKey: string, opts: LinearClientOptions) => LinearClient;

function isRateLimitedMessage(text: string): boolean {
  return /ratelimit|rate limit|too many requests/i.test(text);
}

function isAuthMessage(text: string): boolean {
  return /authentication|not authenticated|invalid api key|unauthorized|forbidden/i.test(text);
}

/** Maps a completed HTTP response (non-2xx) to a prefixed error + ambiguity.
 * 4xx means Linear rejected the request, so a create that got one did NOT
 * write (ambiguous=false). 5xx may have written then failed to respond, so a
 * create that got a 5xx is AMBIGUOUS — the caller keeps its pending link. */
function mapHttpError(
  status: number,
  headers: Headers,
  bodyText: string,
): { error: string; ambiguous: boolean } {
  const detail = bodyText.slice(0, 300).replace(/\s+/g, ' ').trim();
  if (status === 401 || status === 403)
    return { error: `LINEAR_AUTH_FAILED: ${detail || 'unauthorized'}`, ambiguous: false };
  if (status === 429 || headers.get('retry-after'))
    return { error: `LINEAR_RATE_LIMITED: ${detail || 'rate limit exceeded'}`, ambiguous: false };
  if (status === 404)
    return { error: `LINEAR_NOT_FOUND: ${detail || 'not found'}`, ambiguous: false };
  if (status === 400 && isAuthMessage(detail))
    return { error: `LINEAR_AUTH_FAILED: ${detail}`, ambiguous: false };
  if (status === 400 && isRateLimitedMessage(detail))
    return { error: `LINEAR_RATE_LIMITED: ${detail}`, ambiguous: false };
  return {
    error: `LINEAR_UNKNOWN_ERROR: HTTP ${status}${detail ? `: ${detail}` : ''}`,
    ambiguous: status >= 500,
  };
}

/** Maps a GraphQL top-level `errors` array (returned with HTTP 200) to a
 * prefixed error. A rejected GraphQL request is transactional — nothing was
 * written — so ambiguous is always false here. */
function mapGraphqlErrors(errors: unknown[]): { error: string; ambiguous: boolean } {
  const msg = errors
    .map((e) =>
      e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string'
        ? ((e as Record<string, unknown>).message as string)
        : '',
    )
    .filter(Boolean)
    .join('; ')
    .slice(0, 300);
  const code = errors
    .map((e) => {
      const ext =
        e && typeof e === 'object' ? (e as Record<string, unknown>).extensions : undefined;
      if (!ext || typeof ext !== 'object') return '';
      const c = (ext as Record<string, unknown>).code;
      return typeof c === 'string' ? c : '';
    })
    .join(' ');
  const haystack = `${msg} ${code}`;
  if (isRateLimitedMessage(haystack))
    return { error: `LINEAR_RATE_LIMITED: ${msg || 'rate limited'}`, ambiguous: false };
  if (isAuthMessage(haystack))
    return { error: `LINEAR_AUTH_FAILED: ${msg || 'authentication failed'}`, ambiguous: false };
  return { error: `LINEAR_UNKNOWN_ERROR: ${msg || 'GraphQL error'}`, ambiguous: false };
}

function mapThrown(err: unknown): { error: string; ambiguous: boolean } {
  if (err instanceof Error && err.name === 'AbortError') {
    return { error: 'LINEAR_TIMEOUT: request exceeded the configured timeout', ambiguous: true };
  }
  const msg = err instanceof Error ? err.message : String(err);
  // A request that never got a response may still have been received and
  // acted on by Linear -> ambiguous for the create path.
  return { error: `LINEAR_UNKNOWN_ERROR: ${msg}`, ambiguous: true };
}

export function createFetchLinearClient(apiKey: string, opts: LinearClientOptions): LinearClient {
  const headers: Record<string, string> = {
    // Linear personal API keys are sent as the RAW Authorization value — no
    // "Bearer " prefix (that form is for OAuth tokens only).
    Authorization: apiKey,
    'Content-Type': 'application/json',
    'User-Agent': opts.userAgent,
  };

  /** One GraphQL round-trip. `isMutation` drives the ambiguity of a
   * malformed 2xx body (a write may have landed; a read cannot have). */
  async function send(
    query: string,
    variables: Record<string, unknown>,
    isMutation: boolean,
  ): Promise<LinearResult<Record<string, unknown>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(LINEAR_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const mapped = mapHttpError(res.status, res.headers, text);
        return { ok: false, error: mapped.error, ambiguous: mapped.ambiguous };
      }
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return {
          ok: false,
          error: 'LINEAR_UNKNOWN_ERROR: malformed JSON in Linear response',
          // A 2xx mutation may already have written; a read cannot have.
          ambiguous: isMutation,
        };
      }
      const obj = (parsed ?? {}) as Record<string, unknown>;
      if (Array.isArray(obj.errors) && obj.errors.length > 0) {
        const mapped = mapGraphqlErrors(obj.errors);
        return { ok: false, error: mapped.error, ambiguous: mapped.ambiguous };
      }
      const data = obj.data;
      if (data === null || typeof data !== 'object') {
        return {
          ok: false,
          error: 'LINEAR_UNKNOWN_ERROR: Linear response missing data',
          ambiguous: isMutation,
        };
      }
      return { ok: true, value: data as Record<string, unknown> };
    } catch (err) {
      const mapped = mapThrown(err);
      return { ok: false, error: mapped.error, ambiguous: mapped.ambiguous };
    } finally {
      clearTimeout(timer);
    }
  }

  function toRef(node: unknown): LinearIssueRef | null {
    if (node === null || typeof node !== 'object') return null;
    const rec = node as Record<string, unknown>;
    const id = rec.id;
    const url = rec.url;
    const identifier = rec.identifier;
    if (typeof id !== 'string' || typeof url !== 'string') return null;
    return { id, url, identifier: typeof identifier === 'string' ? identifier : '' };
  }

  function refFromMutation(
    data: Record<string, unknown>,
    field: 'issueCreate' | 'issueUpdate',
  ): LinearResult<LinearIssueRef> {
    const payload = data[field];
    if (payload === null || typeof payload !== 'object') {
      return {
        ok: false,
        error: `LINEAR_UNKNOWN_ERROR: ${field} returned no payload`,
        // The mutation reached Linear (2xx, no errors) but the shape is
        // unexpected — treat as ambiguous so a create keeps its pending link.
        ambiguous: true,
      };
    }
    const rec = payload as Record<string, unknown>;
    const ref = toRef(rec.issue);
    if (rec.success !== true || !ref) {
      return {
        ok: false,
        error: `LINEAR_UNKNOWN_ERROR: ${field} did not return success/issue`,
        ambiguous: true,
      };
    }
    return { ok: true, value: ref };
  }

  const ISSUE_FIELDS = 'id identifier url';

  return {
    async createIssue(teamId, payload, stateId) {
      const input: Record<string, unknown> = {
        teamId,
        title: payload.title,
        description: payload.description,
      };
      if (stateId) input.stateId = stateId;
      const res = await send(
        `mutation KtCreate($input: IssueCreateInput!) {
           issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
         }`,
        { input },
        true,
      );
      if (!res.ok) return res;
      return refFromMutation(res.value, 'issueCreate');
    },

    async updateIssue(issueId, payload, stateId) {
      const input: Record<string, unknown> = {
        title: payload.title,
        description: payload.description,
      };
      if (stateId) input.stateId = stateId;
      const res = await send(
        `mutation KtUpdate($id: String!, $input: IssueUpdateInput!) {
           issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
         }`,
        { id: issueId, input },
        true,
      );
      if (!res.ok) return res;
      return refFromMutation(res.value, 'issueUpdate');
    },

    async findIssueByMarker(teamId, marker) {
      // Recovery-only. Linear's `description: { contains }` filter is a
      // server-side substring match; we still re-check the exact marker on
      // each node (defence in depth) and treat a truncated page as
      // unconfirmed so recovery never recreates on a false miss.
      const res = await send(
        `query KtFind($teamId: ID!, $marker: String!) {
           issues(
             filter: { team: { id: { eq: $teamId } }, description: { contains: $marker } }
             first: 20
           ) { nodes { ${ISSUE_FIELDS} description } pageInfo { hasNextPage } }
         }`,
        { teamId, marker },
        false,
      );
      if (!res.ok) return res;
      const issues = (res.value.issues ?? {}) as Record<string, unknown>;
      const nodes = Array.isArray(issues.nodes) ? (issues.nodes as unknown[]) : [];
      for (const node of nodes) {
        if (node && typeof node === 'object') {
          const rec = node as Record<string, unknown>;
          if (typeof rec.description === 'string' && rec.description.includes(marker)) {
            const ref = toRef(node);
            if (ref) return { ok: true, value: ref };
          }
        }
      }
      const pageInfo = (issues.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage === true) {
        return {
          ok: false,
          error:
            'LINEAR_UNKNOWN_ERROR: issue search returned more results than inspected; could not confirm',
          ambiguous: true,
        };
      }
      return { ok: true, value: null };
    },

    async getWorkflowStates(teamId) {
      const res = await send(
        `query KtStates($teamId: String!) {
           team(id: $teamId) { states { nodes { id name type position } } }
         }`,
        { teamId },
        false,
      );
      if (!res.ok) return res;
      const team = res.value.team;
      if (team === null || typeof team !== 'object') {
        return { ok: false, error: `LINEAR_NOT_FOUND: team ${teamId} not found`, ambiguous: false };
      }
      const states = ((team as Record<string, unknown>).states ?? {}) as Record<string, unknown>;
      const nodes = Array.isArray(states.nodes) ? (states.nodes as unknown[]) : [];
      const out: LinearWorkflowState[] = [];
      for (const node of nodes) {
        if (node && typeof node === 'object') {
          const rec = node as Record<string, unknown>;
          if (
            typeof rec.id === 'string' &&
            typeof rec.type === 'string' &&
            typeof rec.position === 'number'
          ) {
            out.push({
              id: rec.id,
              name: typeof rec.name === 'string' ? rec.name : '',
              type: rec.type,
              position: rec.position,
            });
          }
        }
      }
      return { ok: true, value: out };
    },

    async getIssueStateType(issueId) {
      const res = await send(
        `query KtIssueState($id: String!) { issue(id: $id) { state { type } } }`,
        { id: issueId },
        false,
      );
      if (!res.ok) return res;
      const issue = res.value.issue;
      if (issue === null || typeof issue !== 'object') return { ok: true, value: null };
      const state = (issue as Record<string, unknown>).state;
      if (state === null || typeof state !== 'object') return { ok: true, value: null };
      const type = (state as Record<string, unknown>).type;
      return { ok: true, value: typeof type === 'string' ? type : null };
    },
  };
}
