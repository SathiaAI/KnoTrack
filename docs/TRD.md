# KnoTrack — Technical Requirements Document

| | |
|---|---|
| Document version | 1.0 |
| Date | 2026-08-23 |
| Status | Approved for implementation |
| Server version this TRD describes | `0.1.0` |
| MCP protocol version targeted | `2026-07-28` (stateless — no `initialize`/`initialized` handshake, no `Mcp-Session-Id`) |

## 0. Scope

KnoTrack is a self-hosted MCP server that gives coding agents (Claude Code/Cowork, Windsurf, Codex CLI, LM Studio, Goose, Hermes) durable, cross-session visibility into a project's tracks, work items, decisions, and drift — without acting as an orchestrator. It never assigns work, never blocks a client from doing anything, and never runs anything on a schedule. Every one of the 14 mandated MCP tools is a single self-contained, synchronous request/response call: no server-side session state is created or consulted between calls, because the target MCP spec revision (2026-07-28) is stateless. Two plain, unauthenticated HTTP routes — `GET /health` and `GET /info` — sit alongside the MCP endpoint for liveness/readiness and static server metadata respectively (§8); neither is an MCP tool call. Every call therefore repeats `project_id` (and `track_id`/`item_id` where relevant) explicitly; the server never infers "the current project" from a prior call.

Deployment model: **self-hosted, single-tenant per instance.** One running KnoTrack process + one Postgres database serves one operator, who may register many projects and point many MCP clients (Claude Code, Windsurf, etc.) at the same instance. There is no multi-tenant control plane, no hosted SaaS, and no cross-instance data sharing. Isolating two teams means running two instances.

---

## 1. Tech Stack

| Layer | Choice | One-line justification |
|---|---|---|
| Runtime | Node.js 20+ | Current LTS at time of writing; native `fetch`, stable ESM, required baseline for `@modelcontextprotocol/sdk`. |
| Language | TypeScript, `strict: true` | Tool contracts are exact JSON shapes crossing a process boundary to arbitrary MCP clients — compile-time shape checking catches contract drift before it reaches a client. |
| MCP implementation | `@modelcontextprotocol/sdk` (official) | Only implementation guaranteed to track the MCP spec's wire format and transport details across revisions; hand-rolling JSON-RPC framing is pure risk with no upside. |
| Database | PostgreSQL (only supported DB) | One of three documented deploy targets is Render's free tier, which has **no attachable persistent local disk** — a SQLite/file-based DB would silently lose all data on every restart there. Postgres is available managed on all three targets (Supabase, Railway, Fly), so it's the only option that works identically everywhere. |
| DB driver | `pg` (node-postgres) | Minimal, direct SQL, no query-builder magic to fight when writing the recursive/graph queries drift detection and dependency validation need. |
| Migrations | Hand-written raw SQL + a small custom runner (`scripts/migrate.ts`) | An earlier draft of this doc specified `node-pg-migrate`; the shipped build instead uses plain numbered `<name>.sql`/`<name>.down.sql` pairs under `migrations/`, applied by a small idempotent runner that tracks applied migrations in a `schema_migrations` table (see `scripts/migrate.ts`'s header comment for the reasoning) — `node-pg-migrate` is not a project dependency. This still avoids a full ORM's (Prisma/TypeORM) schema-modeling layer and extra runtime weight, the same goal the original choice served; it just isn't `node-pg-migrate` specifically. |
| HTTP framework | Fastify | Lightweight, first-class TypeScript types, low overhead, and its raw Node `req`/`res` are directly compatible with the MCP SDK's Streamable HTTP transport, which attaches to the raw HTTP layer rather than an Express-style middleware chain. |
| Testing | Vitest | Native ESM/TS support with no Babel/ts-jest transform step; fast enough to run the full suite (unit + integration against a real Postgres) on every commit. |
| Linting | ESLint + `typescript-eslint` | Type-aware lint rules catch a class of bugs (unsafe `any`, unchecked promise rejections) that matter a lot in code that talks to arbitrary untrusted MCP clients. |
| Formatting | Prettier | Removes formatting bikeshedding entirely; run in CI as a check, not a suggestion. |
| Encryption | Node built-in `node:crypto`, AES-256-GCM | See §5 — deliberately chosen over `pgcrypto` so the decryption key never has to live inside Postgres or touch a SQL statement. |
| Logging | Fastify's built-in Pino logger | Ships with Fastify, structured JSON logs by default, zero extra dependency. |
| Env/config validation | `zod` | Same library already used for tool input schemas (see §3); reused to parse and validate `process.env` at boot so a misconfigured deploy fails fast with a clear message instead of a confusing runtime error. |

---

## 2. Repository Layout

```
knotrack/
├── docs/
│   └── TRD.md
├── src/
│   ├── index.ts                       # process entrypoint: load config, run pre-flight checks, start Fastify
│   ├── config/
│   │   └── env.ts                     # zod schema for process.env -> typed Config object
│   ├── server/
│   │   ├── fastify.ts                 # builds the Fastify instance, registers routes/hooks
│   │   ├── mcp-route.ts               # mounts POST /mcp using StreamableHTTPServerTransport (stateless mode)
│   │   ├── auth.ts                    # bearer-token preHandler hook (see §4)
│   │   └── health-route.ts            # GET /health and GET /info, both plain unauthenticated routes (see §8)
│   ├── mcp/
│   │   ├── server.ts                  # constructs the McpServer instance and registers the 14 canonical tools; /health and /info are mounted as plain Fastify routes, not MCP tools
│   │   ├── context.ts                 # per-call request context (db client, config) via AsyncLocalStorage
│   │   ├── errors.ts                  # KtError class + ERROR_CODES map (see §3.1)
│   │   └── tools/
│   │       ├── register-project.ts
│   │       ├── get-project-status.ts
│   │       ├── list-tracks.ts
│   │       ├── get-track.ts
│   │       ├── get-next-steps.ts
│   │       ├── create-track.ts
│   │       ├── create-item.ts
│   │       ├── record-session-summary.ts
│   │       ├── record-decision.ts
│   │       ├── update-item-status.ts
│   │       ├── check-drift.ts
│   │       ├── render-roadmap.ts
│   │       ├── sync-to-github.ts
│   │       └── sync-to-linear.ts
│   ├── schemas/
│   │   └── tools.ts                   # one zod schema per tool; single source of truth, converted to JSON Schema for tools/list
│   ├── db/
│   │   ├── pool.ts                    # pg.Pool singleton, sized from KNOTRACK_DB_POOL_MAX
│   │   └── queries/
│   │       ├── projects.ts
│   │       ├── tracks.ts
│   │       ├── items.ts
│   │       ├── events.ts
│   │       ├── decisions.ts
│   │       ├── drift-flags.ts
│   │       └── adapters.ts
│   ├── domain/
│   │   ├── dependency-graph.ts        # topo sort + cycle detection, shared by create-track and create-item
│   │   ├── drift-detector.ts          # the 6 drift flag rules (see Appendix C)
│   │   ├── next-steps.ts              # recommendation ranking for kt_get_next_steps
│   │   └── roadmap-renderer.ts        # markdown / mermaid rendering for kt_render_roadmap
│   ├── adapters/
│   │   ├── types.ts                   # SyncAdapter interface
│   │   ├── github/
│   │   │   ├── client.ts              # thin wrapper over GitHub REST API using stored PAT
│   │   │   └── sync.ts
│   │   └── linear/
│   │       ├── client.ts              # thin wrapper over Linear GraphQL API using stored API key
│   │       └── sync.ts
│   └── crypto/
│       └── credential-cipher.ts       # AES-256-GCM encrypt/decrypt for adapter credentials (see §5)
├── tests/
│   ├── unit/                          # domain/ and crypto/ logic, no DB
│   ├── integration/                   # full tool calls against a real Postgres (docker-compose or testcontainers)
│   └── fixtures/
├── migrations/                        # plain numbered <name>.sql / <name>.down.sql pairs, applied by scripts/migrate.ts (§1) — not node-pg-migrate
├── scripts/
│   ├── migrate.ts                     # custom runner: applies migrations/*.sql in order, tracks applied ones in schema_migrations; run via `npm run migrate`, not node-pg-migrate
│   └── generate-token.ts              # prints a new candidate bearer token for KNOTRACK_API_TOKENS
├── .env.example
├── package.json
├── tsconfig.json
├── eslint.config.js                   # flat config (ESLint 9+)
├── .prettierrc.json
├── vitest.config.ts
├── Dockerfile
├── render.yaml                        # Render deploy config (build/start/health-check path)
├── railway.toml                       # Railway deploy config
├── fly.toml                           # Fly.io deploy config
└── README.md
```

**This tree still has known staleness beyond the migrations fix above, not yet fully swept:** `list-tracks.ts`, `get-track.ts`, `get-next-steps.ts`, and `render-roadmap.ts` are now real, dedicated files matching this tree (T2 build-out, first and second slices, 2026-08-26) — `kt_list_tracks`, `kt_get_track`, `kt_get_next_steps`, and `kt_render_roadmap` are fully implemented and no longer in `stubs.ts`. `src/domain/next-steps.ts` and `src/domain/roadmap-renderer.ts` are likewise now real files (the pure ranking/rendering logic each of those two tools is built on). The real `src/mcp/tools/` now has 10 files, not 14 — the remaining 5 unimplemented tools listed individually above (`record-decision.ts`, `update-item-status.ts`, `check-drift.ts`, `sync-to-github.ts`, `sync-to-linear.ts`) are still all registered together in one `stubs.ts` file; `src/db/queries/` has no `decisions.ts` yet (nothing writes to `decisions` until `kt_record_decision` is built); and `src/adapters/` doesn't exist yet at all (no code path uses it until `T5`). Tracked in `docs/ROADMAP.md`'s backlog alongside the other stale-mention sweeps.

---

## 3. Tool Contract Reference

### 3.0 Conventions used below

- All ids (`project_id`, `track_id`, `item_id`, `event_id`, `decision_id`, `flag_id`) are UUID v4 strings. Input schemas mark them `"format": "uuid"`; the actual runtime check is `zod`'s `.uuid()` (RFC 4122, version-agnostic — accepts any valid UUID, not only v4, since ids may originate from `gen_random_uuid()` which produces v4 but the validator does not need to be stricter than "is this a UUID").
- Every input schema below is authored as a `zod` object in `src/schemas/tools.ts` and is the single source of truth. The `@modelcontextprotocol/sdk` converts it to the JSON Schema shown here for `tools/list` responses — the two are guaranteed identical because one is generated from the other, not hand-maintained twice.
- Every input schema is closed (`"additionalProperties": false`). Any field not listed is a `422 VALIDATION_ERROR`.
- Timestamps are ISO-8601 UTC strings with millisecond precision, e.g. `"2026-08-23T14:30:00.000Z"`.
- **Where a tool-level error is returned** (404/409/422/500), see §3.1 for exactly how it is packaged in the MCP response. **401 is never returned by a tool handler** — it is enforced entirely at the HTTP transport layer before any JSON-RPC/tool dispatch happens (see §4). It is listed per-tool below only to record that the tool is reachable at all solely through an authenticated request.
- Authorization model: any request bearing a currently-valid token (§4) has full read/write access to **every** project in this instance. There is no per-project or per-client ACL in v1 — isolating two teams' data means running two separate KnoTrack instances, consistent with the single-tenant-per-deployment architecture.

### 3.1 Error envelope (used by every tool and by the HTTP layer)

```json
{
  "error": {
    "code": "NOT_FOUND",
    "http_status_equivalent": 404,
    "message": "project not found",
    "details": { "project_id": "3f1a2b4c-9d3e-4a2f-8b21-6f0e2c9a1d55" }
  }
}
```

`code` is one of exactly five string constants, each with a fixed `http_status_equivalent`:

| `code` | `http_status_equivalent` | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing, malformed, or unrecognized bearer token. |
| `NOT_FOUND` | 404 | A referenced `project_id` / `track_id` / `item_id` does not exist (or does not exist *within the given project*, which is treated identically to not existing at all — no cross-project existence is ever revealed). |
| `CONFLICT` | 409 | The request is well-formed and all referenced ids exist, but applying it would violate a state invariant (dependency cycle, marking an item done while its dependencies are unmet, syncing to an adapter with no credentials configured). |
| `VALIDATION_ERROR` | 422 | The request body failed JSON Schema validation, or passed schema validation but violates a business rule that isn't state-dependent (e.g. a `depends_on` item exists but belongs to a different track). |
| `INTERNAL_ERROR` | 500 | Anything unexpected: DB connection failure, decryption failure (corrupted ciphertext / wrong key), unhandled exception. Never includes stack traces or raw driver error text in `message`; those go to the server log only. |

**Transport-level delivery of this envelope differs by error type, and this distinction is load-bearing for client implementers:**

- **`UNAUTHORIZED` (401):** produced by the Fastify `preHandler` hook on `POST /mcp`, *before* the request body is parsed as JSON-RPC at all. The HTTP response is a genuine `401` status code with this envelope as the raw JSON body (`Content-Type: application/json`). It is not wrapped in any JSON-RPC or MCP tool-result structure.
- **`NOT_FOUND` / `CONFLICT` / `VALIDATION_ERROR` / `INTERNAL_ERROR`:** these occur *inside* a tool handler, after the JSON-RPC `tools/call` request has already been accepted. Per MCP convention, a tool-execution failure is reported as a **successful JSON-RPC response** whose result has `isError: true` and whose `content` is `[{ "type": "text", "text": "<JSON.stringify of the envelope above>" }]`. This lets the calling agent see and reason about the error instead of the transport erroring opaquely. The HTTP status code for this response is `200`.
- Malformed JSON-RPC itself (bad method name, unparseable body) is handled by the SDK's own default JSON-RPC error responses (`-32600`/`-32601`/`-32700`) and is untouched by KnoTrack's envelope — this only concerns genuinely malformed protocol traffic, not tool-level business errors.
- **Known gap — `VALIDATION_ERROR` for a `tools/call` whose arguments fail `inputSchema` itself** (an unknown property, a malformed UUID, a missing required field): `@modelcontextprotocol/sdk` validates arguments against `inputSchema` *before* invoking KnoTrack's own tool handler, and formats that rejection itself — as an `isError: true` result (matching the bullet above), but with the SDK's own plain-text message as `content[0].text`, not `JSON.stringify` of this envelope. A client parsing that text expecting `{ "error": { "code": "VALIDATION_ERROR", ... } }` gets the SDK's raw message instead. See src/mcp/tool-helpers.ts's header comment for why this isn't fixed: it isn't interceptable per-tool, and the two ways to change it either break `tools/list`'s advertised schemas for all 14 tools or require forking the SDK's internal tool-dispatch handler.

### 3.2 `kt_register_project`

Registers a project, or **upserts** one: this is the only mechanism v1 provides for adding or rotating adapter credentials after initial registration (there is no separate "update credentials" tool in the mandated 14). Uniqueness is on `(source_type, source_ref)`. Calling this again with the same pair updates `name` and/or `adapters` on the existing row (re-encrypting any credentials supplied) and returns the **original** `project_id` unchanged — it never creates a duplicate and never returns `409` for "already exists".

Input schema:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "minLength": 1, "maxLength": 200 },
    "source_type": { "type": "string", "enum": ["github", "linear", "local"] },
    "source_ref": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500,
      "description": "github: 'owner/repo'. linear: team key or team UUID. local: absolute or repo-relative filesystem path."
    },
    "adapters": {
      "type": "object",
      "properties": {
        "github": {
          "type": "object",
          "properties": {
            "personal_access_token": { "type": "string", "minLength": 1, "maxLength": 512 },
            "repo": { "type": "string", "minLength": 1, "maxLength": 200, "description": "owner/repo; defaults to source_ref when source_type is 'github'" }
          },
          "required": ["personal_access_token"],
          "additionalProperties": false
        },
        "linear": {
          "type": "object",
          "properties": {
            "api_key": { "type": "string", "minLength": 1, "maxLength": 512 },
            "team_id": { "type": "string", "minLength": 1, "maxLength": 200 }
          },
          "required": ["api_key", "team_id"],
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  },
  "required": ["name", "source_type", "source_ref"],
  "additionalProperties": false
}
```

Example output:
```json
{ "project_id": "3f1a2b4c-9d3e-4a2f-8b21-6f0e2c9a1d55" }
```

Errors: `401`; `422` (empty `name`, invalid `source_type`, empty `source_ref`, `adapters.github` present without `personal_access_token`, `adapters.linear` present without both `api_key` and `team_id`, any field exceeding the `maxLength` bounds above, any unknown property); `500` (DB write failure, credential-encryption failure). No `404`, no `409` (see upsert semantics above).

### 3.3 `kt_get_project_status`

Input schema:
```json
{
  "type": "object",
  "properties": { "project_id": { "type": "string", "format": "uuid" } },
  "required": ["project_id"],
  "additionalProperties": false
}
```

Example output:
```json
{
  "tracks": [
    {
      "track_id": "8b2e1a10-...",
      "title": "Auth overhaul",
      "status": "on_track",
      "item_counts": { "pending": 2, "in_progress": 1, "done": 3, "blocked": 0 }
    }
  ],
  "drift_flags": [
    {
      "flag_id": "d1e5f0aa-...",
      "flag_type": "STALE_TRACK",
      "severity": "warning",
      "track_id": "8b2e1a10-...",
      "item_id": null,
      "detail": "No session summary recorded for this track in 16 days.",
      "status": "open",
      "raised_at": "2026-08-20T10:00:00.000Z"
    }
  ],
  "recent_events": [
    {
      "event_id": "aa11bb22-...",
      "event_type": "session_summary",
      "track_id": "8b2e1a10-...",
      "summary_text": "Wired up JWT refresh flow.",
      "created_at": "2026-08-22T18:04:00.000Z"
    }
  ]
}
```

`drift_flags` returns only flags with `status = "open"`, newest first, capped at 100. `recent_events` unions `session_summary` events and `decision` events, ordered `created_at DESC`, capped at 20.

Errors: `401`; `404` (`project_id` not found); `422` (malformed uuid); `500`.

### 3.4 `kt_list_tracks`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "status": { "type": "string", "enum": ["on_track", "pivot_pending", "blocked", "done"] }
  },
  "required": ["project_id"],
  "additionalProperties": false
}
```

Example output:
```json
{
  "tracks": [
    {
      "track_id": "8b2e1a10-...",
      "title": "Auth overhaul",
      "status": "on_track",
      "source_doc_ref": "docs/auth-spec.md",
      "depends_on_track_ids": [],
      "item_counts": { "pending": 2, "in_progress": 1, "done": 3, "blocked": 0 },
      "created_at": "2026-08-01T12:00:00.000Z"
    }
  ]
}
```

When `status` is supplied, filtering is a direct `WHERE tracks.status = ...` clause, since track status is a stored column (§3.5) — no post-processing step is needed.

Errors: `401`; `404` (project not found); `422` (bad `status` enum value, malformed uuid); `500`.

### 3.5 `kt_get_track`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "track_id": { "type": "string", "format": "uuid" }
  },
  "required": ["project_id", "track_id"],
  "additionalProperties": false
}
```

Example output:
```json
{
  "track": {
    "track_id": "8b2e1a10-...",
    "title": "Auth overhaul",
    "status": "on_track",
    "source_doc_ref": "docs/auth-spec.md",
    "depends_on_track_ids": [],
    "created_at": "2026-08-01T12:00:00.000Z"
  },
  "items": [
    { "item_id": "0a1b2c3d-...", "title": "Add refresh endpoint", "status": "done", "sequence_position": 1, "depends_on_item_ids": [] },
    { "item_id": "1b2c3d4e-...", "title": "Add rotation tests", "status": "pending", "sequence_position": 2, "depends_on_item_ids": ["0a1b2c3d-..."] }
  ],
  "dependency_graph": {
    "nodes": [
      { "item_id": "0a1b2c3d-...", "title": "Add refresh endpoint", "status": "done" },
      { "item_id": "1b2c3d4e-...", "title": "Add rotation tests", "status": "pending" }
    ],
    "edges": [
      { "item_id": "1b2c3d4e-...", "depends_on_item_id": "0a1b2c3d-..." }
    ]
  }
}
```

`dependency_graph.edges` uses explicit field names (`item_id`, `depends_on_item_id`) rather than generic `from`/`to` specifically to remove any ambiguity about edge direction: the edge `{item_id: A, depends_on_item_id: B}` means "A depends on B; A cannot be marked done until B is done."

**Track status is a stored column (`tracks.status`), not derived.** It defaults to `on_track` and only ever changes via two write paths, both covered elsewhere in this document:

- `kt_create_track` (§3.6) sets the initial value at insert time: `on_track`, or `blocked` if any listed `depends_on` track is not yet `done`.
- `kt_record_decision` (§3.10) sets the referenced track's status to `pivot_pending`, in the same transaction as inserting the decision row.

No other tool writes `tracks.status` — there is no `kt_update_track` tool and no read-time derivation step. A read (this tool, `kt_list_tracks`, `kt_get_project_status`) simply selects the stored value.

Errors: `401`; `404` (project or track not found); `422` (malformed uuid); `500`.

### 3.6 `kt_create_track`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "title": { "type": "string", "minLength": 1, "maxLength": 300 },
    "depends_on": {
      "type": "array",
      "items": { "type": "string", "format": "uuid" },
      "maxItems": 50,
      "default": []
    },
    "source_doc_ref": { "type": "string", "maxLength": 500 }
  },
  "required": ["project_id", "title"],
  "additionalProperties": false
}
```

Example output:
```json
{ "track_id": "9c3d4e5f-..." }
```

**Initial `status` (stored, see §3.5):** the new row's `tracks.status` is set at insert time to `on_track`, unless at least one track listed in `depends_on` does not yet have `status = 'done'`, in which case it is set to `blocked` instead. This is one of exactly two write paths that ever set `tracks.status` — the other is `kt_record_decision` (§3.10), which moves a track to `pivot_pending`.

**Cycle check (systemic invariant):** before insert, the server runs a full topological-sort validation of the project's track-dependency graph *including the proposed new edges* (`src/domain/dependency-graph.ts`, shared with `kt_create_item`). Duplicate ids inside `depends_on` are silently de-duplicated, not an error. Note that with the mandated v1 tool set there is in fact no operation that can introduce an edge pointing *back* to a freshly created node (there is no "add dependency to an existing track" tool), so a true cycle cannot occur through track creation alone today — the check is implemented anyway as a systemic invariant enforced identically at both `kt_create_track` and `kt_create_item`, so the server fails safe the moment any future tool (e.g. a hypothetical `kt_add_track_dependency`) is added, rather than only being caught then.

Errors: `401`; `404` (project not found, or any `depends_on` id does not correspond to an existing track in this project); `409` (dependency cycle detected); `422` (empty `title`, malformed uuid, `depends_on` not an array); `500`.

### 3.7 `kt_create_item`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "track_id": { "type": "string", "format": "uuid" },
    "title": { "type": "string", "minLength": 1, "maxLength": 300 },
    "sequence_position": { "type": "integer", "minimum": 0 },
    "depends_on": {
      "type": "array",
      "items": { "type": "string", "format": "uuid" },
      "maxItems": 100,
      "default": []
    }
  },
  "required": ["project_id", "track_id", "title"],
  "additionalProperties": false
}
```

**Scope restriction (v1):** every id in `depends_on` must belong to the **same** `track_id` as the item being created. Cross-track item dependencies are out of scope for v1 — use a track-level `depends_on` (§3.6) to order work across tracks instead. This keeps the `dependency_graph` returned by `kt_get_track` a single self-contained per-track DAG with no need to reach into other tracks.

If `sequence_position` is omitted, the server assigns `MAX(sequence_position) + 1` within the track (or `1` if the track has no items yet).

Example output:
```json
{ "item_id": "1b2c3d4e-..." }
```

Errors: `401`; `404` (project or track not found, or a `depends_on` id does not exist as an item at all); `409` (dependency cycle detected — same systemic check as §3.6, evaluated over the track's item graph); `422` (empty `title`, negative `sequence_position`, a `depends_on` id exists but belongs to a **different** track — a business-rule violation, not a not-found); `500`.

### 3.8 `kt_get_next_steps`

Advertised via MCP tool annotations as `readOnlyHint: true, idempotentHint: true`. **Advisory only — this tool never assigns, claims, or locks an item; it only ranks candidates for a human or agent to choose from.**

Input schema:
```json
{
  "type": "object",
  "properties": { "project_id": { "type": "string", "format": "uuid" } },
  "required": ["project_id"],
  "additionalProperties": false
}
```

Algorithm (`src/domain/next-steps.ts`), fully deterministic:
1. Select every item with `status = 'pending'`.
2. Keep only items where every `depends_on_item_id` has `status = 'done'` (or the item has no dependencies).
3. Drop items whose track has stored `status = 'blocked'` (`tracks.status`, §3.5 — a plain `WHERE`, no computation needed) — a track-level block always wins over an individually-ready item.
4. Order the survivors by: track status priority (`on_track` before `pivot_pending`, since a track under active reconsideration is deprioritized until the pivot is resolved), then `sequence_position` ascending, then `created_at` ascending.
5. Take the top `KNOTRACK_NEXT_STEPS_LIMIT` (default 5, §7).
6. `reason` is generated from a fixed template:
   - No dependencies: `"No dependencies — ready to start in track \"{track_title}\"."`
   - Has dependencies: `"All {n} dependencies complete — next up in track \"{track_title}\"."`

Example output:
```json
{
  "recommended_items": [
    {
      "item_id": "1b2c3d4e-...",
      "title": "Add rotation tests",
      "track_id": "8b2e1a10-...",
      "track_title": "Auth overhaul",
      "reason": "All 1 dependency complete — next up in track \"Auth overhaul\"."
    }
  ]
}
```
(The mandated minimum shape is `{item_id, reason}`; `title`, `track_id`, `track_title` are additional fields included for client convenience — output is not schema-validated as strictly as input, so additive fields are safe.)

Errors: `401`; `404` (project not found); `422` (malformed uuid); `500`.

### 3.9 `kt_record_session_summary`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "track_id": { "type": "string", "format": "uuid" },
    "summary_text": { "type": "string", "minLength": 1, "maxLength": 10000 },
    "files_touched": {
      "type": "array",
      "items": { "type": "string", "minLength": 1, "maxLength": 1000 },
      "maxItems": 500,
      "default": []
    },
    "items_touched": {
      "type": "array",
      "items": { "type": "string", "format": "uuid" },
      "default": []
    }
  },
  "required": ["project_id", "track_id", "summary_text"],
  "additionalProperties": false
}
```

On success the server inserts the event, then re-runs the drift-detector rules **scoped to this one track only** (not the whole project) and returns whichever flags that scoped pass newly opened. This event is also what resets the `STALE_TRACK` staleness clock (see Appendix C) — a bare `kt_update_item_status` call does **not** reset it, so the signal can't be gamed by toggling a status without ever describing what happened.

Example output:
```json
{
  "event_id": "aa11bb22-...",
  "drift_flags_raised": [
    {
      "flag_id": "e2f3a4b5-...",
      "flag_type": "SEQUENCE_SKIP",
      "severity": "info",
      "detail": "Item 'Add rotation tests' (seq 2) is done while an earlier item 'Add refresh endpoint' (seq 1) is still pending."
    }
  ]
}
```

Errors: `401`; `404` (project or track not found, or an `items_touched` id does not exist as an item at all); `422` (empty `summary_text`, a `files_touched` entry is not a string, `files_touched` exceeding 500 entries or an entry exceeding 1000 characters, an `items_touched` id exists but belongs to a **different** track than `track_id`); `500`.

### 3.10 `kt_record_decision`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "track_id": { "type": "string", "format": "uuid" },
    "title": { "type": "string", "minLength": 1, "maxLength": 300 },
    "rationale": { "type": "string", "minLength": 1, "maxLength": 5000 },
    "what_changed": { "type": "string", "minLength": 1, "maxLength": 5000 }
  },
  "required": ["project_id", "track_id", "title", "rationale", "what_changed"],
  "additionalProperties": false
}
```

Example output:
```json
{ "decision_id": "c4d5e6f7-..." }
```

**Side effect on `tracks.status` (stored, see §3.5):** in the same transaction as the `decisions` insert, the server sets `track_id`'s `tracks.status` to `pivot_pending` — recording a decision is, by definition, the track pivoting on something, and this is one of exactly two write paths for `tracks.status` (the other being `kt_create_track`, §3.6, at creation time).

Errors: `401`; `404` (project or track not found); `422` (`title`, `rationale`, or `what_changed` empty); `500`.

### 3.11 `kt_update_item_status`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "item_id": { "type": "string", "format": "uuid" },
    "status": { "type": "string", "enum": ["pending", "in_progress", "done", "blocked"] }
  },
  "required": ["project_id", "item_id", "status"],
  "additionalProperties": false
}
```

**Business rule:** transitioning to `"done"` requires every `depends_on_item_id` of this item to already be `"done"`. Any other transition (`pending`, `in_progress`, `blocked`, or `done → done`/no-op) is unconstrained.

Example output:
```json
{ "ok": true }
```

Example `409` response body (inside the `isError` envelope, per §3.1):
```json
{
  "error": {
    "code": "CONFLICT",
    "http_status_equivalent": 409,
    "message": "cannot mark item done: 1 unmet dependency",
    "details": { "item_id": "1b2c3d4e-...", "unmet_item_ids": ["0a1b2c3d-..."] }
  }
}
```

Errors: `401`; `404` (project or item not found); `409` (transition to `done` with unmet dependencies); `422` (invalid `status` value, malformed uuid); `500`.

### 3.12 `kt_check_drift`

Full, project-wide, synchronous drift scan. See §6 for the time/size budget and truncation behavior, and Appendix C for the six drift-flag types this evaluates.

Input schema:
```json
{
  "type": "object",
  "properties": { "project_id": { "type": "string", "format": "uuid" } },
  "required": ["project_id"],
  "additionalProperties": false
}
```

Example output:
```json
{
  "flags": [
    {
      "flag_id": "d1e5f0aa-...",
      "flag_type": "STALE_TRACK",
      "severity": "warning",
      "track_id": "8b2e1a10-...",
      "item_id": null,
      "detail": "No session summary recorded for this track in 16 days.",
      "status": "open",
      "raised_at": "2026-08-20T10:00:00.000Z"
    }
  ],
  "truncated": false,
  "scanned_track_count": 12,
  "total_track_count": 12,
  "scan_duration_ms": 184
}
```

Errors: `401`; `404` (project not found); `422` (malformed uuid); `500`. Note: exceeding the time/size budget is **not** an error — it degrades to a `truncated: true` result (§6), by design, so a large project never turns a routine drift check into a hard failure.

### 3.13 `kt_render_roadmap`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "format": { "type": "string", "enum": ["markdown", "mermaid"], "default": "markdown" }
  },
  "required": ["project_id"],
  "additionalProperties": false
}
```

**`markdown` format** (default) — one `##` heading per track in topological (dependency) order, then a checklist of its items in `sequence_position` order:
```
# Roadmap: KnoTrack Demo
_Generated 2026-08-23T14:30:00.000Z_

## Auth overhaul — on_track
- [x] Add refresh endpoint
- [ ] Add rotation tests

## Billing sync — blocked
- [ ] Define webhook contract
```
Item checkbox rendering: `[x]` for `done`, `[ ]` for `pending`, `[~]` for `in_progress`, `[!]` for `blocked`.

**`mermaid` format** — a `graph TD` of track-level dependencies, one node per track labeled `"{title} ({status})"` (double quotes inside a title are replaced with single quotes and newlines stripped, to keep the diagram syntactically valid):
```
graph TD
  t_8b2e1a10["Auth overhaul (on_track)"]
  t_9c3d4e5f["Billing sync (blocked)"]
  t_9c3d4e5f --> t_8b2e1a10
```
(Edge `A --> B` means "A depends on B", matching the `depends_on_track_ids` direction used everywhere else in this document. Here, Billing sync depends on Auth overhaul, which is not yet `done` — consistent with `kt_create_track`'s rule (§3.6) for setting a new track's initial `status` to `blocked`.)

Example output:
```json
{ "content": "# Roadmap: KnoTrack Demo\n_Generated 2026-08-23T14:30:00.000Z_\n\n## Auth overhaul — on_track\n- [x] Add refresh endpoint\n- [ ] Add rotation tests\n" }
```

Degrades gracefully on a large project — see §6 for the exact caps and the truncation-notice text appended to `content`.

Errors: `401`; `404` (project not found); `422` (invalid `format` value); `500`.

### 3.14 `kt_sync_to_github`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "track_id": { "type": "string", "format": "uuid" }
  },
  "required": ["project_id", "track_id"],
  "additionalProperties": false
}
```

Two distinct failure surfaces, deliberately kept separate:
- **Preconditions the caller can fix by calling a different tool first** (no `github` credentials stored for this project) → a real tool-level error, `409 CONFLICT`, via the `isError` envelope (§3.1).
- **Everything about talking to GitHub itself** (bad token, repo not found, rate-limited, network timeout) → **not** an MCP-level error at all; the tool call succeeds and returns the discriminated result `{ok: false, error: "..."}` per the mandated signature, because these are expected, retryable operational outcomes rather than contract violations.

Example success output:
```json
{ "ok": true }
```

Example operational-failure output (still a successful tool call):
```json
{ "ok": false, "error": "GITHUB_RATE_LIMITED: retry after 120s" }
```
Other `error` string prefixes used: `GITHUB_AUTH_FAILED` (401/403 from GitHub — token revoked or insufficient scope), `GITHUB_NOT_FOUND` (repo or issue not found), `GITHUB_TIMEOUT` (exceeded `KNOTRACK_GITHUB_SYNC_TIMEOUT_MS`, default 8000ms), `GITHUB_UNKNOWN_ERROR` (anything else, with the upstream status code appended).

Errors (tool-level, via `isError`): `401`; `404` (project or track not found); `409` (no GitHub credentials configured for this project — i.e. no row in `adapters` for `(project_id, 'github')`); `422` (malformed uuid); `500` (credential decryption failure, unexpected local exception before the GitHub call was even attempted).

### 3.15 `kt_sync_to_linear`

Identical shape and semantics to `kt_sync_to_github`, mirrored for Linear.

Input schema:
```json
{
  "type": "object",
  "properties": {
    "project_id": { "type": "string", "format": "uuid" },
    "track_id": { "type": "string", "format": "uuid" }
  },
  "required": ["project_id", "track_id"],
  "additionalProperties": false
}
```

Example success output:
```json
{ "ok": true }
```
Example operational-failure output:
```json
{ "ok": false, "error": "LINEAR_AUTH_FAILED: API key rejected" }
```
`error` string prefixes: `LINEAR_AUTH_FAILED`, `LINEAR_NOT_FOUND` (team or issue not found), `LINEAR_TIMEOUT` (exceeded `KNOTRACK_LINEAR_SYNC_TIMEOUT_MS`, default 8000ms), `LINEAR_UNKNOWN_ERROR`.

Errors (tool-level, via `isError`): `401`; `404` (project or track not found); `409` (no Linear credentials configured for this project); `422` (malformed uuid); `500`.

---

## 4. Auth Mechanics

**Model:** a single shared-secret pool of bearer tokens per instance, configured entirely via environment variable — no database table, no issuance flow, no per-client identity. This matches the deployment model directly: one operator, a handful of MCP clients on machines they control, all trusted equally.

- **Token source:** `KNOTRACK_API_TOKENS`, a comma-separated list of one or more opaque strings (required at boot; the server refuses to start if it is unset or empty — see §7 — so it is never accidentally reachable with no auth at all).
- **Token format (convention, not enforced):** `kt_` followed by 43 URL-safe base64 characters (32 random bytes / 256 bits of entropy), e.g. `kt_5WbJxZlXdRqTUfSiHhONoLK83WXrB78i4NJYjzw9WmE`. Produced by `npm run generate-token`, which prints one new candidate to stdout (never written anywhere). The server does not validate this shape at auth time — it only requires the presented token to exactly match one entry in `KNOTRACK_API_TOKENS`; this keeps the format a convention for humans, not a parser constraint.
- **Where it's checked:** a Fastify `preHandler` hook registered on `POST /mcp` only (never on `GET /health` or `GET /info`, both of which must stay reachable without credentials — see §8). For every request: read the `Authorization` header, require it to be exactly `Bearer <token>` (case-sensitive scheme, single space), then compare `<token>` against each entry in `KNOTRACK_API_TOKENS`.
- **Comparison method:** to avoid timing side-channels across the whole array, the presented token and every configured token are first hashed with SHA-256, then compared pairwise with `crypto.timingSafeEqual` on the fixed-length 32-byte digests (this also sidesteps `timingSafeEqual`'s requirement that both buffers be equal length, since raw token lengths could otherwise differ and leak length information). A match against **any** entry authorizes the request.
- **On failure** (missing header, wrong scheme, no match): respond `401` with the standard error envelope (§3.1), `message: "missing or invalid bearer token"`. The response never distinguishes "header missing" from "token present but not recognized" — both look identical externally, to avoid giving an attacker a probing oracle.
- **Rotation approach (manual, by design — no in-band rotation API in v1):**
  1. Generate a new token with `npm run generate-token`.
  2. Add it to `KNOTRACK_API_TOKENS` (append, comma-separated) and redeploy. Both old and new tokens are now valid simultaneously — this is what makes the rotation zero-downtime.
  3. Update each MCP client's configuration (Claude Code `mcp.json` `headers`, Windsurf's MCP config, etc.) to the new token, one at a time.
  4. Once every client is confirmed updated, remove the old token from `KNOTRACK_API_TOKENS` and redeploy again.
  - There is no automatic expiry in v1. Operators are advised (README) to rotate on a schedule they choose (e.g. every 90 days) or immediately if a token is suspected leaked (in which case skip straight to removing it in step 4, accepting the resulting downtime for clients not yet updated).

---

## 5. Adapter Credential Encryption

**Decision: application-level AES-256-GCM via Node's built-in `node:crypto`, key from `KNOTRACK_ENCRYPTION_KEY`. Not `pgcrypto`.**

**Rationale:** `pgcrypto`'s `pgp_sym_encrypt`/`pgp_sym_decrypt` require the decryption passphrase to be passed as a SQL argument on every call, which means the key transits the Postgres connection and can end up in `pg_stat_statements`, slow-query logs, or a DBA's SQL console (e.g. Supabase's web-based SQL editor) — exactly the kind of incidental exposure a secrets-at-rest design is supposed to prevent. It also requires the `pgcrypto` extension to be enabled; Supabase ships it by default, but Railway's and Fly.io's plain-Postgres images do not, which would turn "which extension is enabled" into a per-deploy-target gotcha this project explicitly wants to avoid (all three targets must work against the identical schema and codebase). Keeping the key purely in application process memory (read once from an env var at boot, never persisted, never sent to Postgres) means the database only ever stores opaque ciphertext, and a full `pg_dump` of a compromised database reveals nothing without the separately-held key.

**Concrete implementation** (`src/crypto/credential-cipher.ts`):

- **Key:** exactly 32 raw bytes, provided as a base64 string in `KNOTRACK_ENCRYPTION_KEY`. Generate with `openssl rand -base64 32`. Decoded once at boot; the server refuses to start if the decoded length is not exactly 32 bytes.
- **Per-secret encryption:**
  1. Generate a fresh random 12-byte IV: `crypto.randomBytes(12)` (12 bytes / 96 bits is the AES-GCM-recommended nonce size).
  2. `const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })` — `authTagLength` is passed explicitly, not left to the Node default, so the paired decrypt call (below) enforces exactly a 16-byte tag rather than silently accepting a shorter one.
  3. `const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])`
  4. `const authTag = cipher.getAuthTag()` (16 bytes)
  5. Pack `iv || authTag || ciphertext` into a single buffer and persist it as `adapters.encrypted_credential`, alongside the row's `key_version` (see Storage, below).
- **Decryption:**
  1. `const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })` — same explicit option as encryption, so `setAuthTag` below enforces the full 16-byte tag rather than accepting a truncated one.
  2. `decipher.setAuthTag(authTag)`
  3. `const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')`
  4. If `decipher.final()` throws (auth tag mismatch — tampered or corrupted ciphertext, or wrong key), the error is caught, logged server-side with no secret material in the log line, and surfaced to the caller as a generic `500 INTERNAL_ERROR` (never leaking which part of the crypto operation failed).
- **Storage:** table `adapters` — `project_id`, `type` (`'github'` | `'linear'`), `encrypted_credential bytea` (a single packed blob: `iv (12 bytes) || authTag (16 bytes) || ciphertext`, per `src/crypto/credential-cipher.ts`), `config jsonb` (non-secret metadata only), `key_version integer NOT NULL DEFAULT 1` (added by `migrations/004_adapters_key_version.sql` — see the rotation bullet below), unique on `(project_id, type)`. See Appendix A. An earlier draft of this section described a dedicated `adapter_credentials` table with separate `ciphertext`/`iv`/`auth_tag`/`key_version` columns — the already-applied migration (`migrations/001_init.sql`) never had that table; it packs the first three secret components into the one `encrypted_credential` column instead. `key_version` itself does exist, just on `adapters` directly rather than a separate table. `src/crypto/credential-cipher.ts`'s header comment documents the packed-blob choice as a deliberate fit to the real, already-migrated schema, not an oversight.
- **Never returned:** the `adapters.config` column stores **only non-secret metadata** — e.g. `{"owner": "acme", "repo": "widgets"}` for GitHub, `{"team_id": "..."}` for Linear. (There is no `projects.adapters` column; an earlier draft of this section described one, but it was never part of the migrated schema — see `docs/DATABASE_SCHEMA.md`'s `projects` table.) As of this build, `kt_get_project_status`, `kt_list_tracks`, and `kt_get_track` don't yet serialize any adapter data into their responses at all — none of the three currently reads the `adapters` table. If/when they do, they must read only `config`, never `encrypted_credential`. Neither `src/adapters/github/client.ts` nor `src/adapters/linear/client.ts` exists in the repo yet (both are `T5` work, not started) — the intent is for the `encrypted_credential` column to be read **only** by those two files, immediately before making an outbound API call in `kt_sync_to_github`/`kt_sync_to_linear`, never appearing in any tool's output type, but that is a design intent for `T5`, not a verifiable access boundary in the current build. As of this build, the only code that actually reads `encrypted_credential` is `listAdaptersForProject` (`src/db/queries/adapters.ts`), whose `SELECT *` includes the column; it currently has no production caller.
- **Key rotation:** `scripts/rotate-encryption-key.ts` rotates every stored adapter credential to a new `KNOTRACK_ENCRYPTION_KEY`. It reads the current key from `KNOTRACK_ENCRYPTION_KEY` and the new key from `KNOTRACK_ENCRYPTION_KEY_NEW` (same base64/32-byte shape), decrypts every `adapters` row with the current key, re-encrypts with the new key, and bumps `key_version` — all inside one transaction, so a failure partway through (wrong current key, a corrupted row) rolls back every row rather than leaving some on the old key and some on the new one. It also prints the new key value back on success, since a rotation that completes without the operator retaining that value makes every just-rotated credential permanently undecryptable — the same "print secrets to stdout only" convention `scripts/generate-token.ts` already uses. This is a manual, operator-run, offline-key-swap rotation: KnoTrack v1 never supports more than one *active* encryption key on a running server, so the operator runs this script, then updates `KNOTRACK_ENCRYPTION_KEY` to the new value and redeploys — restarting the server with the old key still configured, in between, would leave it unable to decrypt what the script just re-encrypted. `key_version` exists specifically so a future rotation implementation (or an operator auditing rotation history) can tell which rows are on which generation of key; nothing in v1 currently branches on its value beyond incrementing it. Invocation differs by target, same split as `scripts/migrate.ts` (§2): `npm run rotate-encryption-key` locally (via `tsx`), or `node dist/scripts/rotate-encryption-key.js` in the Docker runtime image, where `tsx` and `scripts/*.ts` are both absent (only `dist` and production dependencies are copied in).

---

## 6. Non-Functional Technical Targets

### 6.1 Response time budgets (p95, measured server-side from request-received to response-sent, excluding network)

| Tool class | Tools | Budget |
|---|---|---|
| Simple reads | `kt_get_project_status`, `kt_list_tracks`, `kt_get_track`, `kt_get_next_steps` | **< 200ms** — one to a handful of indexed queries. |
| Plain HTTP routes | `GET /health`, `GET /info` | **< 200ms** — not MCP tools; see §8 for both specs. |
| Writes | `kt_register_project`, `kt_create_track`, `kt_create_item`, `kt_record_session_summary`, `kt_record_decision`, `kt_update_item_status` | **< 300ms** — includes the dependency/cycle-check query on top of the write. |
| Full drift scan | `kt_check_drift` | **< 2000ms** typical; **hard-capped at `KNOTRACK_DRIFT_SCAN_TIMEOUT_MS`** (default 5000ms), past which it returns a `truncated: true` partial result rather than erroring (§6.3). |
| Roadmap render | `kt_render_roadmap` | **< 1500ms** for projects up to 50 tracks / 500 items total; beyond that, degrades per §6.3 rather than slowing further. |
| External sync | `kt_sync_to_github`, `kt_sync_to_linear` | **< 3000ms** typical, bounded by the external API; a hard **8000ms** timeout (`KNOTRACK_GITHUB_SYNC_TIMEOUT_MS` / `KNOTRACK_LINEAR_SYNC_TIMEOUT_MS`) against the outbound call, past which the tool returns `{ok: false, error: "GITHUB_TIMEOUT"}` / `{ok: false, error: "LINEAR_TIMEOUT"}`. |

### 6.2 Postgres connections

- `pg.Pool` is a **single process-wide singleton** (`src/db/pool.ts`), `max` connections controlled by `KNOTRACK_DB_POOL_MAX` (default **10**).
- Rationale for a low default: this is a self-hosted, single-tenant server expected to serve a handful of MCP clients on one operator's machines, not a multi-tenant fleet — 10 concurrent connections is generous headroom for that load while staying well under every free/small-tier Postgres connection cap across the three deploy targets (Supabase free tier's default pooled limit, Railway's small Postgres plan, Fly's smallest Postgres allocation), leaving room for the platform's own management connections.
- Documented ceiling: operators may raise `KNOTRACK_DB_POOL_MAX`, but the README recommends staying at or below **20** for exactly that reason.
- `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000` on the pool — a connection that can't be acquired in 5s surfaces as a `500 INTERNAL_ERROR`, not an indefinite hang.

### 6.3 Graceful degradation on a large project

Both `kt_check_drift` and `kt_render_roadmap` are explicitly flagged in this document as **candidates for the MCP Tasks extension** (asynchronous, resumable long-running operations) in a future version — but Tasks is not part of the 2026-07-28 spec baseline this server targets, so v1 keeps both **synchronous, capped, and time-boxed** within a single request instead of ever spawning background work the stateless protocol has no way to let a client poll for.

**`kt_check_drift`:**
- Scans at most `KNOTRACK_DRIFT_SCAN_TRACK_CAP` tracks (default **500**) and `KNOTRACK_DRIFT_SCAN_ITEM_CAP` items (default **5000**) per invocation, oldest-track-first (by `created_at`) if the project exceeds the cap.
- Wrapped in a wall-clock budget of `KNOTRACK_DRIFT_SCAN_TIMEOUT_MS` (default **5000ms**) via `Promise.race` against a timer; if the timer wins, whatever flags were computed for the tracks processed so far are returned immediately.
- Either limit being hit sets `"truncated": true` in the response, alongside `scanned_track_count` and `total_track_count` so the caller can see exactly how partial the result is. This is a normal, non-error response (§3.12) — a large project degrades to "less thorough" rather than "broken."

**`kt_render_roadmap`:**
- Renders at most `KNOTRACK_ROADMAP_TRACK_CAP` tracks (default **200**) and, per track, at most `KNOTRACK_ROADMAP_ITEM_PER_TRACK_CAP` items (default **100**), in the same topological/sequence order used elsewhere.
- Same 5000ms wall-clock budget as drift scanning; if hit mid-render, the partial content generated so far is returned rather than the request timing out.
- Because the tool's only output field is `content` (a single string), truncation is communicated **inline**, appended as the final line(s) of that string, e.g.:
  ```
  > Roadmap truncated: showing 200 of 341 tracks. Some tracks omit items beyond the first 100.
  ```

---

## 7. Environment Variables

| Name | Required? | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | **Required** | — | Postgres connection string (`postgres://user:pass@host:port/db`). Supabase, Railway, and Fly's managed Postgres add-ons each inject this automatically when attached. |
| `KNOTRACK_API_TOKENS` | **Required** | — | Comma-separated list of one or more accepted bearer tokens (§4). Server refuses to boot if unset or empty — deliberately, so an instance can never be accidentally reachable with no auth. |
| `KNOTRACK_ENCRYPTION_KEY` | **Required** | — | Base64-encoded 32-byte key for AES-256-GCM adapter-credential encryption (§5). Server refuses to boot if unset, malformed base64, or not exactly 32 decoded bytes. Rotating this value requires running `npm run rotate-encryption-key` first (§5) — a second variable, `KNOTRACK_ENCRYPTION_KEY_NEW`, is read only by that script, never by the server itself, so it's deliberately not a row in this table. |
| `NODE_ENV` | Optional | `production` | Standard Node environment flag; controls default logging verbosity and `DATABASE_SSL_MODE`'s own default. |
| `PORT` | Optional | `8080` | HTTP listen port. **Must** be read from the environment first — Render, Railway, and Fly.io all inject their own `PORT` value and route external traffic to it; a hardcoded port breaks all three. |
| `HOST` | Optional | `0.0.0.0` | HTTP bind address. Must be `0.0.0.0` (not `localhost`/`127.0.0.1`) for the process to be reachable inside any of the three platforms' containers. |
| `DATABASE_SSL_MODE` | Optional | `require` in production, `disable` otherwise | Controls whether the `pg.Pool` is configured with TLS at all (`ssl: { rejectUnauthorized: <KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED> }` when `require`, no `ssl` option when `disable`). Supabase and most managed Postgres require TLS on their public connection string. **Fly.io quirk:** when connecting to a Fly Postgres app over its private `6PN` internal network (the normal, recommended path), the server does not present a TLS certificate — set this to `disable` for that configuration, or `require` if connecting over Fly's public proxy instead. |
| `KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED` | Optional | `true` | Only consulted when `DATABASE_SSL_MODE=require` and `KNOTRACK_DB_SSL_CA_BASE64` is unset. Verifies the Postgres server's TLS certificate against trusted CAs by default. Set to `false` only for a broken/self-signed local dev certificate — never in production, since disabling it keeps the channel encrypted but accepts any certificate (vulnerable to MITM). |
| `KNOTRACK_DB_SSL_CA_BASE64` | Optional | unset | Base64-encoded PEM certificate to pin and verify the Postgres server against, for a managed Postgres that presents a self-signed cert even on its private network. **Railway quirk:** Railway's managed Postgres (the `postgres-ssl` image) always presents a self-signed certificate, including over Railway's private network — full CA-chain verification (the default) fails against it. Setting this variable to that certificate's base64-encoded PEM verifies against it specifically instead of falling back to `KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED=false`, so the connection is both encrypted and authenticated rather than merely encrypted. When set, this always wins over `KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED`. Not needed for Supabase, Fly.io, or local dev. See `docs/deploy/railway.md` for how to extract the certificate and what to do when it rotates (Railway's image renews it automatically as it nears expiry, roughly every ~820 days). |
| `KNOTRACK_DB_POOL_MAX` | Optional | `10` | Max `pg.Pool` connections (§6.2). Recommended ceiling **20**. |
| `KNOTRACK_DRIFT_SCAN_TRACK_CAP` | Optional | `500` | Max tracks scanned per `kt_check_drift` call (§6.3). |
| `KNOTRACK_DRIFT_SCAN_ITEM_CAP` | Optional | `5000` | Max items scanned per `kt_check_drift` call (§6.3). |
| `KNOTRACK_DRIFT_SCAN_TIMEOUT_MS` | Optional | `5000` | Wall-clock budget for `kt_check_drift` before returning a truncated result (§6.3). |
| `KNOTRACK_ROADMAP_TRACK_CAP` | Optional | `200` | Max tracks rendered per `kt_render_roadmap` call (§6.3). |
| `KNOTRACK_ROADMAP_ITEM_PER_TRACK_CAP` | Optional | `100` | Max items rendered per track per `kt_render_roadmap` call (§6.3). |
| `KNOTRACK_STALE_TRACK_DAYS` | Optional | `14` | Days of no `kt_record_session_summary` event on an `on_track` track before `STALE_TRACK` fires (Appendix C). |
| `KNOTRACK_NEXT_STEPS_LIMIT` | Optional | `5` | Max items returned by `kt_get_next_steps` (§3.8). |
| `KNOTRACK_GITHUB_SYNC_TIMEOUT_MS` | Optional | `8000` | Hard timeout on the outbound GitHub API call inside `kt_sync_to_github` (§6.1). |
| `KNOTRACK_LINEAR_SYNC_TIMEOUT_MS` | Optional | `8000` | Hard timeout on the outbound Linear API call inside `kt_sync_to_linear` (§6.1). |
| `LOG_LEVEL` | Optional | `info` | Fastify/Pino log level (`fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`). |

**Deploy-target quirks summary** (all three run the identical codebase/schema — no target-specific branches in application code, only environment-variable configuration):

- **Render (free tier):** no persistent local disk — this is *the* reason Postgres-only is mandated (§1). Requires `GET /health` (§8) configured as Render's health-check path, since free-tier instances spin down on idle and Render polls this path to detect when the cold-started instance is ready again; the first request after a cold start may exceed the §6.1 budgets and this is an accepted, documented exception rather than a bug. Migrations run via Render's Pre-Deploy Command, set to `node dist/scripts/migrate.js` (not `npm run migrate` — see the Railway note below for why the compiled form is required); Render's Start Command remains `node dist/src/index.js` and does not run migrations itself.
- **Railway:** `DATABASE_URL` is auto-injected into the app's environment when a Postgres plugin is attached in the same project — no manual wiring needed. Migrations run via Railway's **Pre-Deploy Command** (`deploy.preDeployCommand`), set to `node dist/scripts/migrate.js` — **not** a `startCommand` wrapper, which was this project's original design and is now known-broken: Railway's Dockerfile-detected build path silently ignores `deploy.startCommand` entirely, so a migrate-then-start wrapper there never actually ran migrations (see `docs/ROADMAP.md`'s `T3` status and `docs/LESSONS_LEARNED.md`'s 2026-08-29 entry for the full incident). `deploy.startCommand` is a plain `node dist/src/index.js`; it doesn't run migrations itself and doesn't need to, since the Pre-Deploy Command already ran them exactly once before it starts. Also **not** `npm run migrate && npm start` for either field: `npm run migrate` invokes `tsx scripts/migrate.ts`, and `tsx` is a devDependency the production Docker image deliberately omits (`npm ci --omit=dev`, see `Dockerfile`'s header comment), so that command fails in the actual deployed container even though it works locally — use the compiled `node dist/scripts/migrate.js` / `node dist/src/index.js` forms. See `docs/deploy/railway.md`.
- **Fly.io:** `DATABASE_URL` comes from `fly postgres attach`. See the `DATABASE_SSL_MODE` row above for the private-networking TLS quirk. Migrations run via `fly.toml`'s `release_command`, set to `node dist/scripts/migrate.js` alone — **not** paired with a start command: `release_command` is a one-off task Fly runs once before any new Machine takes traffic, not the app's own process; the app's start command (`node dist/src/index.js`) is separate and unrelated. Same compiled-form requirement as Railway above applies here too: `npm run migrate` invokes `tsx`, a devDependency omitted from the production image.

---

## 8. Health / Readiness / Info Endpoints

**`GET /health`** — combines liveness and readiness into a single endpoint by design, since all three platforms' free/small-tier health checkers hit exactly one configured URL with no custom headers and no concept of "check two things." **Unauthenticated** — it must never require the `Authorization` header, or platform health checkers (which never send one) would report the instance permanently unhealthy.

**Behavior:**
1. The Fastify process being able to answer at all is baseline liveness.
2. The handler additionally runs `SELECT 1` against the connection pool with a **1000ms** timeout, to confirm actual DB reachability (not just process liveness) — a KnoTrack instance whose Postgres is unreachable is not meaningfully "healthy" even though the HTTP server itself is up.
3. Total handler time budget: **under 2000ms**, comfortably inside the ~2–5s default health-check timeouts these platforms use; the 1000ms DB-query timeout leaves headroom for the rest of the handler.

**Success (DB reachable) — `200 OK`:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "mcp_protocol_version": "2026-07-28",
  "uptime_seconds": 4213,
  "db": "ok"
}
```

**Failure (DB unreachable or the `SELECT 1` timed out) — `503 Service Unavailable`:**
```json
{
  "status": "error",
  "version": "0.1.0",
  "uptime_seconds": 4213,
  "db": "error",
  "error": "db_unreachable"
}
```

**Cold-start / migration ordering (critical for Render and Railway):** migrations are run as a **separate deploy-time step** — the compiled `node dist/scripts/migrate.js` (never `npm run migrate`, which invokes `tsx` and fails in the production image that omits it as a devDependency — see §7), via Render's and Railway's **Pre-Deploy Command** or Fly's `release_command` (see §7; Railway's original `startCommand` wrapper design is known-broken and superseded — §7 has the incident detail) — and must complete **before** the application process starts listening on `PORT`. `/health` never runs migrations and never blocks waiting for them — it assumes the schema is already current by the time the process is accepting connections at all, so a platform's repeated health-check polling during a slow migration can never race a half-migrated schema.

**`GET /info`** — static server metadata. A **plain, unauthenticated HTTP route**, not an MCP tool: the target 2026-07-28 MCP spec has no `initialize` handshake to carry `serverInfo`/capability negotiation, but this information is operationally useful to fetch without an authenticated MCP round-trip (e.g. a deploy-verification script, or a client deciding which adapters it can rely on before it ever presents a bearer token), so it is mounted alongside `/health` rather than exposed as one of the 14 MCP tools.

Behavior: no arguments, no auth, no DB access — always `200 OK`, computed entirely from in-process state.

**Response — `200 OK`:**
```json
{
  "server_version": "0.1.0",
  "mcp_protocol_version": "2026-07-28",
  "supported_adapters": ["github", "linear"],
  "instance_started_at": "2026-08-23T09:00:00.000Z"
}
```

`/info` deliberately does not disclose the Node.js runtime version (adversarial-review
security-5, docs/ROADMAP.md T9.x): it was pure recon value for an unauthenticated caller
fingerprinting the server ahead of a targeted Node CVE, with no documented client behavior
depending on it.

---

## Appendix A — PostgreSQL Schema

**The authoritative schema is `migrations/001_init.sql`** (plus `002_projects_unique_source_ref.sql`, `003_drift_flags_open_unique.sql`, `004_adapters_key_version.sql`, and `005_tracks_sync_timestamps.sql`), applied by the custom runner at `scripts/migrate.ts` (§1). It is not reproduced here.

An earlier draft of this Appendix carried a full hand-copied DDL block that, by the time this note was written, had drifted from the schema actually built — across nearly every table, not just the adapter-credential shape already called out in §5. Concretely, the old block: named a fictional `adapter_credentials` table instead of the real `adapters` table (§5); described `projects` with a `source_ref` that's actually nullable and a `projects.adapters` column that was never built; put a `project_id` column directly on `items` that doesn't exist (item→project scoping goes through `track_id` only); gave `tracks` two `last_github_sync_at`/`last_linear_sync_at` columns that, at the time this note was written, didn't exist anywhere in the real schema — that gap is now closed by `migrations/005_tracks_sync_timestamps.sql` (see the Appendix B note on `SYNC_DRIFT`, below); described `drift_flags` with a six-value `flag_type` plus separate `severity` and `status` columns, where the real table has just a two-value `kind` plus `resolved_at` (see `src/db/queries/drift-flags.ts`'s header comment); and omitted the `api_tokens` table and the `set_updated_at` trigger infrastructure entirely.

Keeping a second, hand-maintained copy of the DDL in this doc is exactly what let that drift accumulate silently — the same lesson `src/crypto/credential-cipher.ts` and `src/db/queries/adapters.ts` already document for the credential-storage piece specifically. This Appendix now points at the single source of truth instead of duplicating it. For the full table reference — columns, constraints, indexes, and the rationale behind each design choice — see `docs/DATABASE_SCHEMA.md`; for how each table maps to a tool's request/response contract, see this document's §3.

Note on `items.status`: **item status is stored** and is the terminal write target of `kt_update_item_status`, which can set it to any of the four values. `tracks.status` is also stored (§3.5), but with a narrower set of writers: only `kt_create_track` (initial value) and `kt_record_decision` (→ `pivot_pending`) ever write it — there is no tool analogous to `kt_update_item_status` for tracks.

---

## Appendix B — Drift Flag Catalog (`kt_check_drift`, `kt_record_session_summary`'s scoped re-check)

**This table is the spec-level catalog, not a literal column list.** The real `drift_flags`
table has a `kind` column (CHECK-restricted to `'out_of_sequence'` | `'orphan_file_change'`)
and `resolved_at`, not a `flag_type`/`severity`/`status` set of columns — `src/db/queries/
drift-flags.ts`'s header comment documents the exact mapping this build uses (`flag_type` in
tool output = `kind` upper-cased/renamed per a fixed table; `severity` is derived from `kind`,
not stored; `status` = `'open'` when `resolved_at IS NULL`, else `'resolved'`). Of the six
`flag_type`s below, only `SEQUENCE_SKIP` (`kind = 'out_of_sequence'`) is ever actually raised
in this build, by `kt_record_session_summary`'s scoped re-check — `kt_check_drift` itself
(which would run the full catalog) is a stub (`src/mcp/tools/check-drift.ts`). The DB's other
allowed kind, `orphan_file_change`, maps to a flag_type (`ORPHAN_FILE_CHANGE`) reserved for a
future `kt_check_drift` rule and is **not** the same thing as `ORPHAN_ITEM` below despite the
similar name — it's never raised anywhere in this build.

| `flag_type` | `severity` | Trigger condition |
|---|---|---|
| `STALE_TRACK` | `warning` | Track's stored status is `on_track` **and** no `session_summary` event referencing that `track_id` has `created_at` within the last `KNOTRACK_STALE_TRACK_DAYS` days (default 14). If the track has zero events ever, measured from the track's `created_at` instead. |
| `DEPENDENCY_GAP` | `critical` | An item has `status = 'done'` while at least one of its `depends_on_item_id` items does **not** have `status = 'done'`. (Should be prevented at write time by `kt_update_item_status`'s 409 check — this flag exists as a defensive integrity check, e.g. for data that predates that rule or was touched directly in the DB.) |
| `SEQUENCE_SKIP` | `info` | An item with `sequence_position = k` and `status = 'done'` exists while another item in the **same track** with `sequence_position < k` has `status` of `pending` or `blocked` — i.e. work finished out of its intended order. Informational, not necessarily wrong. |
| `UNDOCUMENTED_DECISION` | `warning` | A `decisions` row exists for a track, and **no** `events` row for that same `track_id` has `created_at` later than the decision's `created_at` — i.e. a decision was logged but no subsequent session summary shows it was acted on. |
| `ORPHAN_ITEM` | `warning` | An item's `depends_on_item_id` points to an item belonging to a **different** `track_id` than the item itself. (Should be prevented at write time by `kt_create_item`'s same-track restriction — defensive check only, e.g. for imported/migrated data.) |
| `SYNC_DRIFT` | `warning` | The project has credentials configured for an adapter (a row exists in `adapters` for `github` and/or `linear`), and the track's `updated_at`-equivalent (most recent item status change or event on that track) is later than its `last_github_sync_at` / `last_linear_sync_at` respectively — i.e. local state has moved since the last successful sync. `last_github_sync_at`/`last_linear_sync_at` are updated only on a successful (`{ok: true}`) `kt_sync_to_github`/`kt_sync_to_linear` call. |

**Schema decided (Paul, 2026-08-25); rule still unbuilt.** `last_github_sync_at`/`last_linear_sync_at` now exist as nullable `timestamptz` columns directly on `tracks` (`migrations/005_tracks_sync_timestamps.sql`) — scoped per track, not on `adapters`, since `uq_adapters_project_type` allows only one adapter row per `(project_id, type)` and a project can have more than one track syncing through that same adapter; a `tracks`-scoped column has no such sharing problem, while an `adapters`-scoped one would make syncing track A silently mark track B "up to date" too. See that migration's header comment for the full reasoning, including why a `track_id`+`adapter_id` join table was considered and rejected (no real second-adapter-per-type case exists to join against, given `uq_adapters_project_type`). This closes the schema gap only: `SYNC_DRIFT` itself is still unbuilt (the only two `kind` values `drift_flags` currently accepts, `out_of_sequence` and `orphan_file_change`, still don't include a sync-drift kind — that plus `kt_sync_to_github`/`kt_sync_to_linear`'s actual implementation remain T6/T5 work, not started).

---

## Appendix C — Track & Item Status Enums (reference)

- **Item status** (`items.status`, stored): `pending` | `in_progress` | `done` | `blocked`. Set only via `kt_update_item_status`; defaults to `pending` at creation.
- **Track status** (`tracks.status`, stored): `on_track` | `pivot_pending` | `blocked` | `done`. Set at creation (`kt_create_track`) and by `kt_record_decision` (→ `pivot_pending`); no other tool changes it.
