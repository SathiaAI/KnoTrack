# KnoTrack — Product Requirements Document

**Version:** 1.0
**Status:** Approved for implementation
**Date:** 2026-08-23 (§4 tool contracts, §5.3 Security, and the stray mentions in §6/§8 were reconciled against `docs/TRD.md` and the shipped implementation on 2026-09-07 — see `docs/ROADMAP.md` for the reconciliation record. `docs/TRD.md` is the authoritative wire-level contract; this section of the PRD restates it in product terms and must not drift from it again.)
**Owner:** KnoTrack maintainers

This document is written to be implemented with zero follow-up questions. Every place that would normally be marked "TBD" or "needs discussion" has instead been resolved to a specific decision, with a one-line rationale. If a future implementer disagrees with a decision, that is a v2 proposal, not an ambiguity in v1.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Target Users / Personas](#3-target-users--personas)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Success Metrics](#6-success-metrics)
7. [Out of Scope for v1](#7-out-of-scope-for-v1)
8. [Glossary](#8-glossary)
9. [Appendix: Data Model Reference](#9-appendix-data-model-reference)

---

## 1. Problem Statement

### 1.1 Why project drift happens

When a human works alone, they hold the plan in their head and notice, intuitively, when they've wandered off it. When an AI coding agent (or several, across several tools) works on the same project, that intuition disappears:

- **Every agent session starts cold.** A fresh Claude Code, Cowork, Windsurf, or Codex CLI session has no memory of what the last session decided, why, or what was explicitly deferred. It re-derives context from whatever files it happens to read.
- **The plan lives in prose, not structure.** Roadmaps, specs, and ticket descriptions are read by agents as unstructured text. "Do X before Y" is a sentence, not a constraint the agent's next action is checked against.
- **Multiple tools touch one project.** A solo developer might plan in Linear, implement with Claude Code, and patch a bug with Windsurf the same afternoon. None of these tools share a notion of "what already happened" unless something explicitly keeps a cross-tool record.
- **Nobody re-reads the roadmap once work starts.** The plan document is a snapshot from the start of a track. Actual work drifts from it silently — a dependency gets skipped because it's inconvenient, or a file gets touched that has nothing to do with the declared piece of work — and nothing flags it because no one is comparing "what was declared" against "what actually happened."

The result: by the time a human looks up, the roadmap is fiction, the sequencing has been violated in ways nobody decided on purpose, and there is no record of *when* or *why* it diverged — only a diff between the doc and the code that nobody can explain.

### 1.2 Why existing orchestrators don't solve this

Orchestration frameworks (multi-agent dispatchers, task-queue systems, autonomous "agent swarm" runners) solve a different problem: *getting work done by assigning it to agents and sequencing their execution*. They are necessarily prescriptive about how work is executed. That is precisely what makes them a poor fit for status, sequencing-advice, and drift detection as a *general-purpose, cross-tool* capability:

- An orchestrator is normally single-harness (built into or bolted onto one specific agent runtime). It has no reason to also work identically inside Windsurf, LM Studio, Goose, or Hermes — its job ends at the harness boundary.
- An orchestrator's "status" view is a projection of its own dispatch queue, not an independent read of a project's source-of-truth documents. If the orchestrator didn't dispatch the work, it usually doesn't know it happened.
- Orchestrators treat drift as a scheduling problem to *prevent* (by controlling execution order), not as a *reporting* problem to surface after the fact for a human or another system to act on. A project that already has a working orchestrator does not need another system fighting it for control of execution order.
- None of the orchestration tools surveyed treat "drift" as a first-class, structurally-computed, auditable record — it is usually implicit in whatever the scheduler happens to have queued.

KnoTrack is deliberately the complement, not the competitor: it is a **read-mostly, advice-only** layer that any agent harness can call into over MCP, that never takes control of execution, and that is equally at home sitting next to a project with no orchestrator (its default mode) and a project that already has one (where KnoTrack's `kt_get_next_steps` output becomes one more input the orchestrator's human owner can consult — KnoTrack never talks to the orchestrator, dispatches to it, or expects it to exist).

### 1.3 How KnoTrack actually gets plan data in (important scope clarification)

KnoTrack does **not** parse arbitrary roadmap/spec file formats out of a local folder. There is no "point KnoTrack at a directory and it figures out the plan" tool in v1. Concretely:

- **Local-folder projects:** the calling agent (which already has filesystem access — that's what Claude Code, Windsurf, etc. are for) reads the project's roadmap/spec/ticket files itself, and populates KnoTrack's structured model by calling `kt_create_track` / `kt_create_item`. KnoTrack is the structured record the agent writes into, not a document parser.
- **GitHub-backed and Linear-backed projects:** `kt_sync_to_github` / `kt_sync_to_linear` (§4.13, §4.14) each push one track's state outward to GitHub/Linear, scoped per call — they are one-way exports, not a bulk or free-text import mechanism, and there is no tool in v1 that pulls existing GitHub Issues or Linear Issues into KnoTrack Items. A project backed by either still gets its Tracks/Items populated the same way as a local-folder project: the calling agent reads whatever already exists there and calls `kt_create_track`/`kt_create_item`.

This is a deliberate v1 boundary, not an oversight: building a robust free-text roadmap parser is a large, format-specific problem with poor reliability, and it is unnecessary work when the calling agent can already read the file and make two structured tool calls. See §7 for the formal scope statement.

---

## 2. Goals and Non-Goals

### 2.1 Goals

- G1. Give any AI agent, in any MCP-capable harness, a single, structured place to ask "what is the current status of this project" and get the same answer regardless of which harness is asking.
- G2. Give any AI agent a deterministic, explainable, advisory ranking of "what unblocked work exists next," without ever assigning or executing that work.
- G3. Detect drift — sequencing violations and untracked work — **structurally**, from an append-only event log compared against the declared plan, not from an agent's self-report.
- G4. Keep an explicit, human-readable audit trail of intentional pivots (Decisions) separate from the plan itself, so "we meant to do this" is always distinguishable from "this just happened."
- G5. Work identically across heterogeneous MCP clients (Claude Code/Cowork, Windsurf, Codex CLI, LM Studio, Goose, Hermes, and others) by targeting the MCP 2026-07-28 stateless spec and never relying on server-side session memory.
- G6. Be trivially self-hostable by a single developer with no ops background, on at least one genuinely free path, in under 30 minutes.
- G7. Support, not replace, a project's existing orchestrator if one exists — KnoTrack has no concept of "the" orchestrator and does not attempt to detect, integrate with, or gate one.

### 2.2 Non-Goals ("KnoTrack will never...")

- KnoTrack will never assign, dispatch, trigger, or execute work on behalf of any agent. `kt_get_next_steps` returns a ranked *recommendation*; nothing in the system calls out to an agent, a CI system, or a queue.
- KnoTrack will never require or assume a specific agent harness. Any MCP 2026-07-28-compliant client is a first-class citizen.
- KnoTrack will never infer a Decision (an intentional pivot) from a boolean flag or from silence. A Decision is only ever an explicit, human/agent-authored record with rationale text.
- KnoTrack will never mutate or delete an Event or a Decision once written. The event log and decision log are append-only for the lifetime of the project.
- KnoTrack will never hand-edit `ROADMAP.md`, and will never treat it as an input. It is a rendered, disposable projection of the database, fully overwritten on every render.
- KnoTrack will never run as a shared multi-tenant service operated by the maintainers. Every installer owns their own database and server; the maintainers have no visibility into any installer's data, ever.
- KnoTrack will never phone home. No usage analytics or telemetry leave a self-hosted instance to the maintainers, by design.
- KnoTrack will never block a status update because it looks out of sequence. It will warn; it will not refuse. The human/agent is always the final authority over their own actions.
- KnoTrack will never store adapter credentials (GitHub PAT, Linear API key) anywhere reachable from an MCP client. They live server-side only.
- KnoTrack will never claim compatibility it has not actually verified the way it claims to have verified it (see §5.4 for exactly how each client's compatibility was established).

---

## 3. Target Users / Personas

### 3.1 The solo multi-tool developer ("Priya")

Runs three side projects. Plans in a plain Markdown roadmap file in each repo. Uses Claude Code for scaffolding, Windsurf for UI work, and occasionally Codex CLI for quick scripts — often switching mid-project depending on which is fastest for the task at hand. Priya's core pain: every time she switches tools, the new session has no idea what the last tool did, and she has caught herself re-doing work and, once, shipping a feature whose declared dependency wasn't actually finished. She wants one status view that all three tools update and read from, and a nagging-but-not-blocking warning when something is done out of order.

**What KnoTrack gives Priya:** register each repo as a Project once; every harness gets the same bearer token in its own MCP config; `kt_get_project_status` and `kt_get_next_steps` give her (and her agents) a consistent view no matter which tool she opens.

### 3.2 The small team (2–6 developers, one shared backend)

A small team sharing one Linear workspace and one GitHub repo, each developer running their own preferred agent harness against a shared KnoTrack instance that one of them deployed. Their pain: Linear tickets say one thing, but two developers' agents have started overlapping work because neither's agent checked what the other's session already touched. They want a shared, structural drift signal that isn't just "did you remember to update the ticket."

**What KnoTrack gives them:** one shared self-hosted instance (single Postgres database, single server) with one bearer token per developer, drawn from the same shared token pool (there is no per-device issuance flow — an operator generates and distributes tokens manually, §5.3); `kt_record_session_summary` after every session gives a shared Event log; structural drift detection (§4.11) gives a non-self-reported view of whether anyone stepped out of declared sequence; `kt_sync_to_linear` pushes track state back out to the team's actual tickets.

### 3.3 The open-source installer who is not the original author

Found KnoTrack on GitHub, is not a KnoTrack contributor, and just wants to run it for their own unrelated project. They have no interest in reading the source. Their pain: most self-hosted OSS tools either require Docker/Kubernetes expertise or turn out to have a hidden paid dependency once you're three steps into setup.

**What KnoTrack gives them:** one deploy path that is actually built, deployed, and verified end-to-end — Railway+Postgres, with a real, incident-tested runbook (`docs/deploy/railway.md`) — plus two further target designs (Render+Supabase, Fly.io) that are documented as planned paths but not yet deployed or verified (§5.5), with the real cost/limitation of all three stated up front so an installer knows exactly which one is proven today, an Apache 2.0 license with a NOTICE file so they know exactly what attribution is required, and a setup path that ends in a working bearer token and a first `kt_register_project` call with no undocumented step in between.

---

## 4. Functional Requirements

### 4.0 Conventions used throughout this section

- All 14 tools are exposed over MCP following the **2026-07-28 stateless MCP spec**: every call is self-contained and includes every ID it needs (`project_id`, and further-scoped IDs as applicable). No tool relies on "the last project you registered," "the current track," or any other server-side session memory — a stateless server has none to rely on, and KnoTrack's implementation must not simulate it via in-memory globals either, since MCP clients may (and do) round-robin calls across reconnecting transports.
- IDs are plain UUIDs (`gen_random_uuid()`, no prefix) — see `docs/DATABASE_SCHEMA.md` for the canonical column definitions.
- All tool inputs are validated against a JSON Schema with `additionalProperties: false`. Unknown fields are rejected, not ignored — this catches client-side typos immediately instead of silently dropping data.
- All tool outputs are returned as a single JSON object inside the MCP tool result's text content block.
- Errors use a **five-value code set**, each with a fixed HTTP-status equivalent: `UNAUTHORIZED` (401), `NOT_FOUND` (404), `CONFLICT` (409), `VALIDATION_ERROR` (422), `INTERNAL_ERROR` (500). There is no separate code for a dependency cycle, a missing adapter credential, or an upstream GitHub/Linear failure — a cycle or a missing-credential precondition is reported as `CONFLICT`; a business-rule violation that doesn't depend on current data state (e.g. a `depends_on` id that exists but belongs to the wrong track) is `VALIDATION_ERROR`. The envelope shape is `{ "error": { "code", "http_status_equivalent", "message", "details" } }`. `UNAUTHORIZED` is the one code never produced by a tool handler itself — it's enforced entirely at the HTTP layer, before any tool is dispatched (§5.3), and is delivered as a genuine HTTP `401` with this envelope as the raw JSON body. Every other code is delivered as a **successful** JSON-RPC `tools/call` response (`isError: true`, with the JSON-encoded envelope as the result's text content) — HTTP status `200` — per MCP convention for a tool-execution failure, not a transport failure. **Known exception:** a call the MCP SDK's own `inputSchema` validation rejects before it ever reaches a tool handler (an unknown property, an invalid UUID, a missing required field) is also `isError: true`, but its `content[0].text` is the SDK's own plain-text `"Input validation error: ..."` message, not this JSON envelope — see `src/mcp/tool-helpers.ts`'s header comment for why this one case can't be intercepted and reformatted.
- `project_id` is a required input on every tool except `kt_register_project`. Passing a `track_id`, `item_id`, `event_id`, or `decision_id` that exists but does not belong to the given `project_id` is always a `NOT_FOUND` error (scoped lookup, not global lookup) — this prevents one project's IDs from ever being usable to read or write another project's data, which matters once a single instance hosts more than one project.
- No tool call is retried automatically by the server; MCP clients are responsible for their own retry policy. Writes that touch more than one table (e.g. a track insert plus its dependency edges, or an item insert plus a sequence-position shift) run inside a single database transaction, so a failure partway through never leaves partial rows.
- Pagination: v1 does not paginate `kt_list_tracks` or `kt_get_track`'s item listing. `kt_get_project_status` (§4.2) has a hard cap on a read tool's fixed-size output: `drift_flags` capped at the 100 most-recent open flags and `recent_events` capped at the 20 most recent — both fixed limits, not caller-adjustable inputs; there is no `event_limit` input on any tool. `kt_render_roadmap` (§4.12) is capped the same way but on tracks/items rather than flags/events — at most `KNOTRACK_ROADMAP_TRACK_CAP` tracks (default 200) and `KNOTRACK_ROADMAP_ITEM_PER_TRACK_CAP` items per track (default 100), truncation communicated inline in `content` rather than a separate flag. `kt_check_drift`'s project-wide scan (§4.11) has its own separate caps — track/item counts and a wall-clock budget, all operator-configured via environment variables (`docs/TRD.md` §6.3/§7), not per-call inputs — and there is no `since`-based incremental scanning in v1; every scan is full-project.

### 4.1 `kt_register_project`

**Description:** Registers a Project, or upserts one on `(source_type, source_ref)` — calling it again with the same pair updates the existing row (name, adapters) and returns the *original* `project_id` rather than erroring or creating a duplicate. This is also the only mechanism to add or rotate adapter credentials after initial registration, since credentials are supplied directly in the call rather than read from server-side configuration.

**Inputs:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string, 1–200 chars | yes | Display name. Not required to be unique — uniqueness is on `(source_type, source_ref)`, not `name` (see Business rules). |
| `source_type` | enum: `"github" \| "linear" \| "local"` | yes | What kind of source `source_ref` identifies. |
| `source_ref` | string, 1–500 chars | yes | Repo URL, Linear project ID, or local filesystem path, depending on `source_type`. |
| `adapters` | object `{ github?, linear? }` | no | Per-adapter credentials, supplied directly in the call (not read from server env vars). `github: { personal_access_token, repo? }`; `linear: { api_key, team_id }`. |

**Output:** `{ project_id }`

**Business rules / edge cases:**
- Uniqueness is enforced on `(source_type, source_ref)`, not on `name`. Calling again with the same `(source_type, source_ref)` pair upserts: name and any supplied adapter credentials are updated on the existing row, and the call returns that row's original `project_id` — never a `CONFLICT`, never a duplicate project.
- Credentials in `adapters.github`/`adapters.linear` are encrypted (AES-256-GCM, §5.3) before being persisted into the `adapters` table's `encrypted_credential` column (one row per project+adapter type, unique on `(project_id, type)` — not a separate `adapter_credentials` table); they are never echoed back in this or any other tool's output.
- If encrypting or persisting a supplied adapter credential fails (e.g. a crypto/database error), the whole call fails with a generic `500 INTERNAL_ERROR` rather than partially succeeding — this is a hard failure, not a soft-fail-with-warnings path. There is no "requested an adapter with no credential configured" case, since credentials are supplied inline on the call rather than resolved from server-side configuration.

**Acceptance criteria:**
- **Given** no project exists with `source_type: "github", source_ref: "acme/widgets"`, **when** `kt_register_project` is called with `name: "Acme API", source_type: "github", source_ref: "acme/widgets"`, **then** the call succeeds and returns a new `project_id`.
- **Given** a project already exists with `source_type: "github", source_ref: "acme/widgets"`, **when** `kt_register_project` is called again with the same `source_type`/`source_ref` and a different `name`, **then** the call succeeds, the existing row's `name` is updated, and the same `project_id` as before is returned.
- **Given** a valid `adapters.github.personal_access_token` is supplied, **when** `kt_register_project` is called, **then** the call succeeds and the token is stored encrypted in the `adapters` table's `encrypted_credential` column, never appearing in the tool's output or in any other tool's output.

### 4.2 `kt_get_project_status`

**Description:** The primary "what's going on with this project" overview call.

**Inputs:** `project_id` (required) — only. There is no `event_limit` input; the caps below are fixed.

**Output:**
```
{
  tracks: [ { track_id, title, status, item_counts: { pending, in_progress, done, blocked } } ],
  drift_flags: [ { flag_id, flag_type, severity, track_id, item_id, detail, status, raised_at } ],
  recent_events: [ { event_id, event_type, track_id, summary_text, created_at } ]
}
```

**Business rules / edge cases:**
- `drift_flags` is a **live query** of every currently-open flag (`status: "open"`, i.e. `resolved_at IS NULL` at the database level) in the project's `drift_flags` table, newest first, capped at 100. There is no caching layer and no `drift_last_checked_at` field — this call always reads whatever is currently open. Flags are written by whichever tool's drift computation raised them; as of this build that is only `kt_record_session_summary`'s scoped per-track re-check (§4.8) — `kt_check_drift` (§4.11), which would populate the full catalog, is not yet implemented. This call itself only ever reads flags; it never computes new ones.
- `recent_events` unions `session_summary` events (from `kt_record_session_summary`) and `decision` events (from `kt_record_decision`), ordered `created_at` descending, capped at 20 — always the 20 most recent overall, regardless of the mix of the two types.
- A project with zero tracks returns `tracks: []` — this is valid, not an error.
- `project_id` not found → `NOT_FOUND`.

**Acceptance criteria:**
- **Given** a project with 3 tracks and zero open drift flags, **when** `kt_get_project_status` is called, **then** `drift_flags` is `[]`.
- **Given** `kt_record_session_summary` raised a `SEQUENCE_SKIP` flag that is still unresolved, **when** `kt_get_project_status` is called any time after, **then** `drift_flags` contains that flag — there is no separate "last checked" timestamp to reconcile against, since the read is always live.
- **Given** more than 20 events exist for the project, **when** `kt_get_project_status` is called, **then** `recent_events` contains exactly the 20 most recent, newest first.
- **Given** an unknown `project_id`, **when** `kt_get_project_status` is called, **then** the call fails with `NOT_FOUND`.

### 4.3 `kt_list_tracks`

**Description:** List a project's tracks, optionally filtered by status.

**Inputs:** `project_id` (required), `status` (optional enum: `on_track | pivot_pending | blocked | done`). There is no `include_items` input — this tool never returns item detail; use `kt_get_track` (§4.4) for that.

**Output:** `{ tracks: [ { track_id, title, status, source_doc_ref, depends_on_track_ids, item_counts: { pending, in_progress, done, blocked }, created_at } ] }`

**Business rules / edge cases:**
- Invalid `status` value → `VALIDATION_ERROR` naming the four allowed values.
- No tracks match the filter → `{ tracks: [] }`, not an error.
- Filtering, when `status` is supplied, is a direct `WHERE tracks.status = ...` clause against the stored column (§4.4 has the full note on track status being stored, not derived) — no post-processing step.

**Acceptance criteria:**
- **Given** a project with 2 `on_track` and 1 `blocked` track, **when** `kt_list_tracks` is called with `status: "blocked"`, **then** exactly 1 track is returned.
- **Given** `status: "in_progress"` (a valid Item status, not a Track status), **when** `kt_list_tracks` is called, **then** the call fails with `VALIDATION_ERROR`.
- **Given** no `status` filter, **when** `kt_list_tracks` is called, **then** every track in the project is returned, each including `item_counts` and `depends_on_track_ids`.

### 4.4 `kt_get_track`

**Description:** Full detail for one track: its items and the resolved item-level dependency graph.

**Inputs:** `project_id` (required), `track_id` (required).

**Output:**
```
{
  track: { track_id, title, status, source_doc_ref, depends_on_track_ids, created_at },
  items: [ { item_id, title, status, sequence_position, depends_on_item_ids } ],
  dependency_graph: {
    nodes: [ { item_id, title, status } ],
    edges: [ { item_id, depends_on_item_id } ]   // "item_id depends on depends_on_item_id"
  }
}
```

**Business rules / edge cases:**
- `track_id` must belong to `project_id`; if it belongs to a different project or doesn't exist, `NOT_FOUND`.
- **Track status is a stored column, not derived at read time.** It defaults to `on_track` and changes via exactly two write paths, both documented elsewhere in this section: `kt_create_track` (§4.6) sets the initial value at insert; `kt_record_decision` (§4.9) moves a track to `pivot_pending`. No other tool writes it, and there is no tool that ever moves a track back out of `blocked` or `pivot_pending` — a known, open product gap tracked separately (PR-review Finding 2), not something this reconciliation resolves. This tool, `kt_list_tracks`, and `kt_get_project_status` all simply select the stored value.
- `dependency_graph` is item-level only, and always confined to this track: `kt_create_item` (§4.7) restricts every `depends_on` entry to an item already in the same track, so a track's item dependency graph is always a single, self-contained DAG. Track-to-track dependencies appear on `track.depends_on_track_ids` instead, not in this graph. There is no "dangling dependency" concept in v1 — there is no delete tool for tracks or items, so a `depends_on` reference that no longer resolves isn't a case the schema needs to represent.

**Acceptance criteria:**
- **Given** track T has 4 items in sequence positions 1, 2, 3, 4, **when** `kt_get_track` is called, **then** `items` is returned in that exact order.
- **Given** item A (in track T) declares `depends_on: [B]` where B is a different item also in track T, **when** `kt_get_track` is called for T, **then** `dependency_graph.edges` includes `{ item_id: A, depends_on_item_id: B }`.
- **Given** a `track_id` that exists but belongs to a different `project_id` than the one supplied, **when** `kt_get_track` is called, **then** the call fails with `NOT_FOUND`.

### 4.5 `kt_get_next_steps`

**Description:** The advisory ranking tool. Returns ready-to-start items in a deterministic priority order with a stated reason for each. **This tool never assigns, dispatches, or executes anything, and it is the one guarantee in this document that most directly defines what KnoTrack is not.**

**Inputs:** `project_id` (required) — only. There is no `track_id`, `limit`, or `include_blocked_tracks` input in v1: the result count is controlled server-side by the `KNOTRACK_NEXT_STEPS_LIMIT` environment variable (default 5), and items in a `blocked` track are always excluded with no per-call way to opt back in.

**Output:**
```
{
  recommended_items: [
    { item_id, title, track_id, track_title, reason }
  ]
}
```
There is no `advisory_notice` field echoed on every response and no `blocking_summary` — "advisory only" is a documented product principle (§2.2, §7) enforced by this call never writing anything, not a field repeated in every payload.

**Ranking algorithm (deterministic, must be reproduced exactly — `src/domain/next-steps.ts`):**
1. Select every item with `status: "pending"`.
2. Keep only items where every `depends_on_item_id` has `status: "done"` (or the item has no dependencies).
3. Drop items whose track's stored `status` is `blocked` (§4.4) — a track-level block always wins, unconditionally.
4. Order the survivors by: (a) track status priority — `on_track` before `pivot_pending`; (b) `sequence_position` ascending; (c) `created_at` ascending; (d) `id` ascending as the final, fully deterministic tie-break — needed because track priority, `sequence_position`, and `created_at` can all still tie (e.g. two items created in the same millisecond).
5. Take the top `KNOTRACK_NEXT_STEPS_LIMIT` items (default 5).
6. `reason` is generated from a fixed template, not a free-form summary: `"No dependencies — ready to start in track \"{track_title}\"."` when the item has none, `"All {n} dependency complete — next up in track \"{track_title}\"."` (singular) when `n` is 1, or `"All {n} dependencies complete — next up in track \"{track_title}\"."` (plural) when `n` is greater than 1 — exactly reproducible from the same DB state.

**Business rules / edge cases:**
- This call performs **no writes**. It creates no Event and has zero side effects on the database — this is the concrete mechanism, not just a policy statement, by which "advisory only" is enforced.
- If no item qualifies anywhere in the project, `recommended_items` is `[]`. There is no separate "here's what's blocking everything" field in v1 — a caller that wants that has to inspect tracks/items directly via `kt_list_tracks`/`kt_get_track`.
- A project with zero items returns `recommended_items: []`.

**Acceptance criteria:**
- **Given** track T is `on_track` with item A (`pending`, no deps, position 1) and item B (`pending`, depends on A, position 2), **when** `kt_get_next_steps` is called, **then** `recommended_items[0].item_id == A`; B is absent (its dependency isn't done yet).
- **Given** every item in the project is either done, in progress, blocked, or has an unmet dependency, **when** `kt_get_next_steps` is called, **then** `recommended_items` is `[]`.
- **Given** any valid input, **when** `kt_get_next_steps` is called, **then** no Event row is created as a result of the call (verified by comparing the project's Event count before and after).
- **Given** track T2 is `blocked` and contains an otherwise-ready item C, **when** `kt_get_next_steps` is called, **then** C never appears in `recommended_items` — there is no input in v1 that changes this.

### 4.6 `kt_create_track`

**Description:** Create a new Track within a project. Its initial status is always derived, never supplied directly.

**Inputs:** `project_id` (required), `title` (required, 1–300 chars), `depends_on` (optional array of `track_id`, max 50 entries, default `[]`, must already exist in the same project), `source_doc_ref` (optional string, max 500 chars — a free-text pointer to where this track's plan lives, e.g. a roadmap file path or ticket URL). There is no `description` and no `initial_status` input.

**Output:** `{ track_id }`

**Business rules / edge cases:**
- **Initial `status` is derived at insert time:** `on_track`, unless at least one track listed in `depends_on` does not yet have `status: "done"`, in which case the new track is created `blocked`. This is one of exactly two write paths that ever set a track's `status` — the other is `kt_record_decision` (§4.9), which moves a track to `pivot_pending`. As noted in §4.4, **no tool moves a track back out of `blocked` or `pivot_pending`** once it's there in this build — a known, open gap (PR-review Finding 2), not addressed by this reconciliation pass.
- Duplicate ids inside `depends_on` are silently de-duplicated, not an error.
- Track-level `depends_on` must not introduce a cycle in the project's track-dependency graph — a full topological-sort validation over existing tracks plus the proposed new edges, shared with `kt_create_item`'s item-level check. On detection, the call fails with `CONFLICT`. In practice, v1's tool set has no way to create a genuine cycle through track creation alone (there is no "add a dependency to an existing track" tool once a track exists), but the check runs anyway as a systemic invariant that fails safe the moment a future tool could introduce one.
- Any `depends_on` entry referencing a `track_id` that does not exist in this project → `NOT_FOUND`.
- Duplicate `title` across tracks in the same project is allowed and produces no warning — titles are not checked for collision at creation time in this build; there is no `warnings` field on the output.

**Acceptance criteria:**
- **Given** track A already exists and is `done`, **when** `kt_create_track` is called for track B with `depends_on: [A]`, **then** B is created with `status: "on_track"`.
- **Given** track A exists and is not yet `done`, **when** a new track is created with `depends_on: [A]`, **then** the new track is created with `status: "blocked"`.
- **Given** track A depends on track B, **when** the cycle-detection check is evaluated against a hypothetical edge that would close B→A, **then** it fails with `CONFLICT` — illustrating the invariant's defensive behavior; this scenario is not reachable through this build's tool surface, since `kt_create_track` cannot add a `depends_on` edge to the already-existing track A (see the note above).
- **Given** a `depends_on` entry naming a `track_id` that doesn't exist in the project, **when** `kt_create_track` is called, **then** the call fails with `NOT_FOUND`.

### 4.7 `kt_create_item`

**Description:** Create a new Item inside a Track. An item's status always starts at `pending`; there is no create-time override.

**Inputs:** `project_id`, `track_id` (required), `title` (required, 1–300 chars), `sequence_position` (optional integer ≥ 0; auto-assigned as `MAX(existing positions in this track) + 1`, or `1` if the track has no items yet, when omitted), `depends_on` (optional array of `item_id`, max 100 entries, default `[]`). There is no `description`, `file_patterns`, or `initial_status` input.

**Output:** `{ item_id }`

**Business rules / edge cases:**
- **Scope restriction (v1):** every `depends_on` id must belong to the *same* `track_id` as the item being created. Cross-track item dependencies are out of scope for v1 — a track-level `depends_on` (§4.6) is the way to order work across tracks instead. This keeps `kt_get_track`'s `dependency_graph` (§4.4) a single self-contained per-track DAG.
- `sequence_position` is **not** required to be unique per track at the database level (see `docs/DATABASE_SCHEMA.md`'s `items` table — an index exists for ordered fetch, not a uniqueness constraint). If the caller supplies a position already taken within that track, KnoTrack renumbers by shifting every existing item at or after that position one place later, inside the same transaction as the insert, so the new item lands exactly where requested without ever producing a duplicate.
- `depends_on` cycle detection runs over this track's item-dependency graph only (items may only depend on other items in the same track, so a cross-track cycle can't occur). As with track-level `depends_on` (§4.6), v1's tool set has no way to add a `depends_on` edge to an already-existing item — `kt_create_item` only sets `depends_on` at creation time, and every id it references must already exist — so a genuine item-level cycle cannot actually be constructed through this build's tool surface; the check runs anyway as a systemic invariant that fails safe (`CONFLICT`) the moment a future tool could introduce one.
- `depends_on` referencing an item id that does not exist at all → `NOT_FOUND`. `depends_on` referencing an item id that exists but belongs to a **different** track → `VALIDATION_ERROR` (a business-rule violation, not a not-found, since the id is real).

**Acceptance criteria:**
- **Given** track T has items at positions 1 and 2, **when** `kt_create_item` is called with no `sequence_position`, **then** the new item is assigned position 3.
- **Given** track T has items at positions 1, 2, and 3, **when** `kt_create_item` is called with `sequence_position: 2`, **then** the call succeeds, the new item takes position 2, and the items previously at 2 and 3 now sit at 3 and 4.
- **Given** item A depends on item B and B depends on item C, **when** the cycle-detection check is evaluated against a hypothetical edge that would close C→A, **then** it fails with `CONFLICT` — illustrating the invariant's defensive behavior; this scenario is not reachable through this build's tool surface, since `kt_create_item` cannot add a `depends_on` edge to the already-existing item C (see the note above).
- **Given** a `depends_on` id that exists as an item but belongs to a different track, **when** `kt_create_item` is called, **then** the call fails with `VALIDATION_ERROR`.

### 4.8 `kt_record_session_summary`

**Description:** The call an agent makes at the end of a working session, scoped to one track. Appends an immutable Event, then re-runs the drift-detector's rules scoped to that track — not the whole project — and returns whichever flags newly opened as a result.

**Inputs:** `project_id` (required), `track_id` (**required** — every session summary is scoped to exactly one track), `summary_text` (required string, 1–10,000 chars), `files_touched` (optional array of strings, each 1–1000 chars, max 500 entries, default `[]`), `items_touched` (optional array of `item_id`, default `[]`). There is no `self_reported_drift` or `self_reported_drift_note` field in v1 — an agent's own opinion about whether it drifted is not captured; drift is structural only, computed the same way regardless of what a session claims about itself.

**Output:**
```
{
  event_id,
  drift_flags_raised: [ { flag_id, flag_type, severity, detail } ]
}
```

**Business rules / edge cases:**
- `files_touched` genuinely defaults to `[]` if omitted — omitting it and passing `[]` explicitly are equivalent; there is no requirement to state it explicitly.
- `summary_text` has only a 1-character floor — there is no higher "meaningful session note" length requirement enforced by the schema.
- This call re-runs the drift-detector's `SEQUENCE_SKIP` check — the only one of §4.11's six defined flag types implemented outside `kt_check_drift` — scoped to `track_id` only, and returns any newly-raised flags, except once the track holds more than `KNOTRACK_DRIFT_SCAN_ITEM_CAP` items (same cap `kt_check_drift` uses, default 5000): past that size the re-check is skipped for that call and the Event is still recorded, with `drift_flags_raised: []`. It does **not** recompute drift for the whole project — that requires `kt_check_drift` (§4.11), which is not implemented in this build.
- This Event is also what resets the `STALE_TRACK` flag's staleness clock (§4.11) — a bare `kt_update_item_status` call does **not** reset it, so "has anyone described what happened on this track recently" can't be gamed by toggling a status without ever writing a summary.
- `items_touched` referencing an item that exists but belongs to a different track than `track_id` → `VALIDATION_ERROR`. An `items_touched` id that doesn't exist as an item at all → `NOT_FOUND`.

**Acceptance criteria:**
- **Given** a valid session with `track_id` set, `files_touched: ["src/auth.ts"]`, and `summary_text: "Implemented password reset flow"`, **when** `kt_record_session_summary` is called, **then** an Event is created and `drift_flags_raised` reflects whatever the scoped re-check found (possibly `[]`).
- **Given** `summary_text: ""`, **when** `kt_record_session_summary` is called, **then** the call fails with `VALIDATION_ERROR`.
- **Given** `track_id` omitted, **when** `kt_record_session_summary` is called, **then** the call fails with `VALIDATION_ERROR` (it is required).
- **Given** `files_touched` omitted entirely, **when** `kt_record_session_summary` is called, **then** the call succeeds exactly as if `files_touched: []` had been passed.
- **Given** an item in `items_touched` is done out of declared sequence relative to another item in the same track, **when** `kt_record_session_summary` is called, **then** the resulting `SEQUENCE_SKIP` flag (if newly raised) appears in `drift_flags_raised` (§4.11).

### 4.9 `kt_record_decision`

**Description:** Record an explicit, human/agent-authored pivot or decision. Never inferred — a Decision only exists because this tool was called with real rationale text. Recording one always moves its track into `pivot_pending`.

**Inputs:** `project_id` (required), `track_id` (**required**), `title` (required, 1–300 chars), `rationale` (required, 1–5000 chars, non-empty), `what_changed` (required, 1–5000 chars, non-empty — concrete description, e.g. "Track B reprioritized ahead of Track A because the client moved up the Track B deadline"). There is no `item_ids` input — a Decision is scoped to a track, not to individual items, in v1.

**Output:** `{ decision_id }`

**Business rules / edge cases:**
- `rationale` or `what_changed` being empty → `VALIDATION_ERROR`. This is the entire point of the entity: a Decision must carry real explanatory content, never a bare boolean.
- **Side effect:** in the same transaction as the insert, the referenced track's stored `status` (§4.4, §4.6) is set to `pivot_pending` — recording a decision is, by definition, the track pivoting on something. This is one of exactly two write paths for a track's `status`; the other is `kt_create_track`'s initial-value derivation.
- Decisions are immutable once created — there is no update or delete tool for Decisions in v1. A correction is made by recording a **new** Decision whose `rationale` references the earlier one by ID or description.
- **A Decision does not directly suppress any drift flag.** What it changes instead is the input to one specific flag type: `UNDOCUMENTED_DECISION` (§4.11) fires when a Decision has been recorded for a track but no session-summary Event on that track has a `created_at` later than the Decision's — i.e. a pivot was logged but nothing since shows it was acted on. Recording a subsequent `kt_record_session_summary` for that track is what clears that signal, not the Decision itself. *An earlier draft of this document described Decisions as suppressing `SEQUENCE_DRIFT` findings directly — no such mechanism exists in the shipped build; this paragraph corrects that.*

**Acceptance criteria:**
- **Given** `rationale: ""`, **when** `kt_record_decision` is called, **then** the call fails with `VALIDATION_ERROR`.
- **Given** track T is currently `on_track`, **when** a Decision is recorded for T, **then** T's `status` becomes `pivot_pending` (verifiable via `kt_get_track` or `kt_list_tracks`).
- **Given** a Decision was recorded for track T and no session summary has been recorded for T since, **when** the drift catalog is evaluated against T, **then** an `UNDOCUMENTED_DECISION` flag is present for T.

### 4.10 `kt_update_item_status`

**Description:** Change an Item's status. Blocks exactly one transition — advancing to `done` with unmet dependencies — and is otherwise unconstrained.

**Inputs:** `project_id`, `item_id` (required), `status` (required enum: `pending | in_progress | done | blocked`). There is no `note` input.

**Output:** `{ ok: true }` on success.

**Business rules / edge cases:**
- **Transitioning to `done` requires every one of the item's `depends_on_item_id`s to already be `done`.** If any is not, the call is **rejected** with `CONFLICT` (`details.unmet_item_ids` names the specific unmet dependencies) — the status is **not** changed. *This is a real behavioral correction from an earlier draft of this document, which described the same case as "succeeds with an advisory `sequence_warning`." The shipped tool blocks the transition outright; there is no soft-warning path.*
- Any other transition — to `pending`, `in_progress`, `blocked`, or `done → done` (a no-op) — is unconstrained and always succeeds, including when a dependency is unmet. The dependency check applies only to a transition *into* `done`, never to reaffirming a status the item is already in.
- This call does not run the drift-detector or write any `drift_flags` row. The one flag category that could plausibly relate to an unmet-dependency status change, `DEPENDENCY_GAP` (§4.11), is a defensive check inside the full project-wide scan, not something this call triggers directly — precisely because this call already blocks the one write `DEPENDENCY_GAP` exists to catch.
- `item_id` not belonging to `project_id` → `NOT_FOUND`.

**Acceptance criteria:**
- **Given** item A has an undone dependency, **when** `kt_update_item_status` is called with `status: "done"`, **then** the call fails with `CONFLICT` and `details.unmet_item_ids` lists the unmet dependency.
- **Given** the same scenario, **then** item A's status is unchanged — it remains whatever it was before the rejected call.
- **Given** item A is already `"done"`, **when** `kt_update_item_status` is called again with `status: "done"`, **then** the call succeeds (a no-op, unconstrained even if a dependency has since become un-done — the rule only guards a transition *into* `done`).
- **Given** item A has an undone dependency, **when** `kt_update_item_status` is called with `status: "in_progress"` or `status: "blocked"`, **then** the call succeeds without restriction.

### 4.11 `kt_check_drift`

**Description:** Standalone, on-demand, project-wide structural drift scan. **Registered with its real, TRD-accurate input schema so the full 14-tool surface is visible to clients, but not yet implemented in this build** — calling it currently returns a "not yet implemented" error. This section documents its target contract, which `kt_record_session_summary`'s scoped per-track re-check (§4.8) already implements a slice of.

**Inputs:** `project_id` (required) — only. There is no `track_id` scope and no `since` window in v1; a call always scans the whole project from scratch.

**Output:**
```
{
  flags: [ { flag_id, flag_type, severity, track_id, item_id, detail, status, raised_at } ],
  truncated: boolean,
  scanned_track_count,
  total_track_count,
  scan_duration_ms
}
```

**Drift flag catalog (six defined types; only `SEQUENCE_SKIP` is actually raised anywhere in this build today, via `kt_record_session_summary`'s scoped re-check — the rest are part of this tool's target contract):**

| `flag_type` | `severity` | Trigger condition |
|---|---|---|
| `STALE_TRACK` | `warning` | Track's stored status is `on_track` and no session-summary Event on that track has `created_at` within `KNOTRACK_STALE_TRACK_DAYS` (default 14) days; if the track has zero Events ever, measured from the track's `created_at` instead. |
| `DEPENDENCY_GAP` | `critical` | An item is `done` while at least one of its `depends_on_item_id`s is not `done`. Defensive only — `kt_update_item_status` (§4.10) already blocks this at write time; this flag exists to catch data that predates that rule or bypassed KnoTrack's own tools. |
| `SEQUENCE_SKIP` | `info` | An item at `sequence_position = k` is `done` while another item in the *same track* at a lower `sequence_position` is `pending` or `blocked` — work finished out of its declared order. Informational, not necessarily wrong. |
| `UNDOCUMENTED_DECISION` | `warning` | A Decision exists for a track, and no Event for that same track has a `created_at` later than the Decision's — a pivot was logged but nothing since shows it was acted on (§4.9). |
| `ORPHAN_ITEM` | `warning` | An item's `depends_on_item_id` points to an item in a *different* track. Defensive only — `kt_create_item` (§4.7) already restricts this at write time. |
| `SYNC_DRIFT` | `warning` | The project has credentials configured for an adapter, and a track's most recent activity is later than that adapter's last successful sync of it. **Schema exists (`tracks.last_github_sync_at`/`last_linear_sync_at`); the rule itself is not yet built** — the sync adapters (§4.13, §4.14) and this scan aren't implemented yet either. |

**Business rules / edge cases:**
- Exceeding the scan's track/item caps or its wall-clock time budget (all operator-configured via environment variables — `docs/TRD.md` §6.3/§7) is **not** an error: the call returns whatever was scanned so far with `truncated: true`, `scanned_track_count`, and `total_track_count`, so the caller can see exactly how partial the result is.
- `flags` returns only currently-open flags — the same `drift_flags` rows `kt_get_project_status` (§4.2) reads.

**Acceptance criteria:**
- **Given** an item is `done` out of its track's declared sequence, **when** the drift scan runs (today, via `kt_record_session_summary`'s scoped re-check touching that track), **then** a `SEQUENCE_SKIP` flag is raised for it.
- **Given** a project larger than the configured scan caps, **when** `kt_check_drift` runs (once implemented), **then** the response has `truncated: true` rather than failing outright.
- **Given** this build, **when** `kt_check_drift` is called at all, **then** the call currently fails with a "not yet implemented" error — a known, stub-tool limitation, not a bug in the contract described above.

### 4.12 `kt_render_roadmap`

**Description:** Pure-function rendering of the project's current state as `markdown` or `mermaid` text. Never a write target — there is no filesystem output in v1; the tool always returns the rendered content as a string for the caller to do with as it likes (write to disk, paste into a PR description, display inline).

**Inputs:** `project_id` (required), `format` (optional enum: `markdown | mermaid`, default `markdown`). There is no `output_path`, and this tool never writes to disk. *An earlier draft of this document described a filesystem-write mode (`output_path`, `written`, `overwrote_untracked_file`) — the shipped tool has no such mode at all; this section replaces that description entirely.*

**Output:** `{ content: "<string>" }` — always, regardless of `format`.

**Rendering rules:**
- **`markdown`** (default): one `##` heading per track, in topological (dependency) order, followed by a checklist of its items in `sequence_position` order. Checkbox rendering: `[x]` done, `[ ]` pending, `[~]` in_progress, `[!]` blocked.
- **`mermaid`**: a `graph TD` of track-level dependencies only (no items) — one node per track labeled `"{title} ({status})"`; an edge `A --> B` means "A depends on B," matching `depends_on_track_ids`'s direction used everywhere else in this document. Double quotes inside a title are replaced with single quotes and `\n`/`\r\n` line breaks stripped (a lone `\r` is not matched and passes through), to keep the diagram syntactically valid for the newline forms actually handled.
- On a large project, rendering degrades rather than failing: caps on tracks rendered and items-per-track, plus the same `KNOTRACK_DRIFT_SCAN_TIMEOUT_MS` budget as `kt_check_drift` (all operator-configured, `docs/TRD.md` §6.3/§7), applied to the per-track item-fetch phase — this is a best-effort bound on that phase, not an end-to-end guarantee, since the initial project lookup and the final synchronous sort/render step aren't covered by it. Truncation is communicated **inline**, as trailing lines appended to `content` itself — since the only output field is one string, there's no separate "truncated" flag — e.g. `"> Roadmap truncated: showing 200 of 341 tracks. Some tracks omit items beyond the first 100."`

**Acceptance criteria:**
- **Given** a project with 2 tracks (one `done`, one `on_track` depending on it), **when** `kt_render_roadmap` is called with the default `format`, **then** `content` contains one `##` heading per track with each track's items rendered as a checklist in sequence order.
- **Given** `format: "mermaid"`, **when** `kt_render_roadmap` is called, **then** `content` is a `graph TD` block with one node per track and edges matching each track's `depends_on_track_ids`.
- **Given** a project with more tracks than the configured render cap, **when** `kt_render_roadmap` is called, **then** `content` still returns successfully, with a truncation notice appended as its final line(s) rather than the call failing.

### 4.13 `kt_sync_to_github`

**Description:** **Registered with its real, TRD-accurate input schema; not yet implemented in this build** — calling it currently returns a "not yet implemented" error. This section documents its target contract: one GitHub sync operation, scoped to a single track, per call — there is no `pull`/`push`/direction choice and no item-level sync target in v1.

**Inputs:** `project_id` (required), `track_id` (required). There is no `direction`, `github_repo` override, or `item_id` input.

**Output (by outcome):**
- Success: `{ ok: true }`.
- Operational failure (bad token, repo/issue not found, rate-limited, network timeout) — **a successful tool call, not an MCP-level error**: `{ ok: false, error: "<PREFIX>: <detail>" }`. Defined prefixes: `GITHUB_AUTH_FAILED`, `GITHUB_NOT_FOUND`, `GITHUB_RATE_LIMITED`, `GITHUB_TIMEOUT` (exceeds `KNOTRACK_GITHUB_SYNC_TIMEOUT_MS`, default 8000ms), `GITHUB_UNKNOWN_ERROR`.

**Business rules / edge cases:**
- **Two distinct failure surfaces, deliberately kept separate.** A precondition the caller can fix by calling a different tool first — no GitHub credentials stored for this project (no row in `adapters` for `(project_id, "github")`) — is a real tool-level error, `CONFLICT`, via the standard error envelope. Everything about actually talking to GitHub itself is **not** an MCP-level error at all — the call succeeds and returns the discriminated `{ok: false, error: ...}` result instead, because these are expected, retryable operational outcomes, not contract violations.
- *An earlier draft of this document described a `direction`-based pull/push design with dedup and partial-result reporting across a batch of Issues — the shipped, mandated 14-tool contract has no such design. Each call is one scoped operation on one track, not a bulk import; there is no bidirectional merge or conflict-resolution logic to document.*

**Acceptance criteria:**
- **Given** a project without GitHub credentials configured, **when** `kt_sync_to_github` is called, **then** the call fails with `CONFLICT`.
- **Given** GitHub returns a 403 rate-limit response (once this tool is implemented), **when** called, **then** the response is `{ ok: false, error: "GITHUB_RATE_LIMITED: ..." }` — a successful tool call, not a thrown error.
- **Given** this build, **when** `kt_sync_to_github` is called at all, **then** the call currently fails with a "not yet implemented" error, consistent with its stub status.

### 4.14 `kt_sync_to_linear`

**Description:** Identical shape and semantics to `kt_sync_to_github` (§4.13), mirrored for Linear. Also registered with its real input schema and not yet implemented in this build.

**Inputs:** `project_id` (required), `track_id` (required).

**Output:** `{ ok: true }` on success; `{ ok: false, error: "<PREFIX>: <detail>" }` on an operational failure. Prefixes: `LINEAR_AUTH_FAILED`, `LINEAR_NOT_FOUND`, `LINEAR_TIMEOUT` (exceeds `KNOTRACK_LINEAR_SYNC_TIMEOUT_MS`, default 8000ms), `LINEAR_UNKNOWN_ERROR`.

**Business rules / edge cases (mirrors §4.13 exactly, Linear-specific specifics only):**
- `CONFLICT` for missing Linear credentials (no row in `adapters` for `(project_id, "linear")`); everything about the Linear API call itself is a non-error `{ok: false, ...}` result.

**Acceptance criteria:**
- **Given** a project without Linear credentials configured, **when** `kt_sync_to_linear` is called, **then** the call fails with `CONFLICT`.
- **Given** this build, **when** `kt_sync_to_linear` is called at all, **then** the call currently fails with a "not yet implemented" error, consistent with its stub status.

---

## 5. Non-Functional Requirements

### 5.1 Deployment and data model

- Self-hosted, single-tenant per instance: one Postgres database, one server process (or process group) per installer, per instance. No shared multi-tenant service exists or is offered by the maintainers.
- Because each instance is single-tenant, there is no per-request tenant-isolation logic to get wrong — every row in the database belongs to installer's own instance by construction. This is a deliberate simplification of the security model that a multi-tenant SaaS version would not get to make.
- Three planned deploy targets — Render + Supabase, Railway + Postgres, Fly.io — but as of 2026-09-07 only one has a step-by-step guide actually shipped in the repo and an instance actually deployed against it: Railway (`docs/deploy/railway.md`, `docs/ROADMAP.md` T3, done 2026-09-05). Render+Supabase and Fly.io are documented target designs only — a draft runbook covering both exists (`docs/deploy/client-verification-runbook.md`), but it is explicitly unexecuted, and neither platform has actually been deployed to or verified (`docs/ROADMAP.md` T7.1/T7.2, both `blocked`). See §5.5 for the honest cost/limitation profile of each — none is hidden, including this gap.

### 5.2 Reliability

- No formal uptime SLA is offered or meaningful for a self-hosted, installer-operated tool — uptime is the installer's own operational responsibility. KnoTrack's reliability requirements instead focus on **data integrity**, which the maintainers do control through the software's design:
  - Event and Decision rows are strictly append-only at the application layer: the codebase never issues an `UPDATE` or `DELETE` against the `events` or `decisions` tables under any code path — enforced by code-review discipline. A database-level lock-down (`REVOKE UPDATE ON events, decisions FROM <app_role>` — `INSERT`/`SELECT` stay granted, and `DELETE` is deliberately left grantable since `docs/DATABASE_SCHEMA.md` documents it as the path for hard project deletion and cascading legal-erasure cleanup) is documented as an **optional** hardening step an installer can apply themselves (see `migrations/001_init.sql`'s closing comment); it is **not** applied automatically by the shipped migrations, so out of the box this invariant rests on application code discipline, not a database-enforced guarantee. An installer who wants the stronger guarantee runs that `REVOKE` themselves.
  - Multi-statement writes (e.g. `kt_create_track`'s insert plus its dependency edges; `kt_create_item`'s sequence-position shift plus insert; `kt_record_session_summary`'s Event insert plus its scoped drift-flag inserts) run inside a single database transaction. A failure partway through never leaves partial rows.
  - Performance targets (full table in `docs/TRD.md` §6.1): simple reads (`kt_get_project_status`, `kt_list_tracks`, `kt_get_track`, `kt_get_next_steps`) target under 200ms p95; writes (`kt_register_project`, `kt_create_track`, `kt_create_item`, `kt_record_session_summary`, `kt_record_decision`, `kt_update_item_status`) target under 300ms p95; the full `kt_check_drift` scan targets under 2000ms typical, hard-capped at `KNOTRACK_DRIFT_SCAN_TIMEOUT_MS` (default 5000ms) past which it degrades to a `truncated: true` result rather than erroring (§4.11); `kt_render_roadmap` targets under 1500ms for projects up to 50 tracks / 500 items total (TRD §6.1), degrading the same way beyond that; this performance envelope is distinct from the tool's hard truncation caps of 200 tracks / 100 items-per-track (§4.12), which bound response size rather than define the performance target. These are p95 server-side targets, not floor guarantees for every possible request, and are not blended into one number the way an earlier draft of this document stated.

### 5.3 Security

*This section is a full rewrite as of the 2026-09-07 reconciliation (see the document header). An earlier draft described a database-backed, per-client-device bearer-token issuance/revocation system (a `knotrack create-token`/`knotrack revoke-token` CLI, salted-hash storage, a resolved `client_id` stamped onto Events). None of that was ever built. What follows matches the real, shipped auth model exactly — see `docs/TRD.md` §4 for the full implementation-level detail.*

- **Model: a single shared pool of bearer tokens per instance, configured entirely via environment variable.** An `api_tokens` table exists in the schema (Appendix A) from an earlier design, but this auth path never queries it — no issuance flow, no per-client identity — a token is just a string that either is or isn't a member of the configured list. This matches the deployment model directly: one operator, a handful of MCP clients on machines they control, trusted equally.
- **Token source:** `KNOTRACK_API_TOKENS`, a comma-separated list of one or more opaque strings, required at boot — the server refuses to start if it is unset or empty, so an instance can never be accidentally reachable with no auth at all. **Token format (a convention, not enforced):** `kt_` followed by 43 URL-safe base64 characters (32 random bytes / 256 bits of entropy). Generated by `npm run generate-token`, which prints one new candidate to stdout and writes it nowhere else.
- **Where it's checked:** a Fastify hook on `POST /mcp` only — never on `GET /health` or `GET /info` (§8), both of which must stay reachable without credentials for platform health checks to work. A request must present `Authorization: Bearer <token>` exactly (case-sensitive scheme, single space); the presented token is compared against every entry in `KNOTRACK_API_TOKENS` (both sides SHA-256-hashed first, then compared pairwise with `crypto.timingSafeEqual` on the fixed-length digests, to avoid timing side-channels and length-mismatch leaks). A match against **any** entry authorizes the request. On failure, the response is a genuine HTTP `401` with the standard error envelope (§4.0) — it never distinguishes "no header" from "token present but not recognized," to avoid giving an attacker a probing oracle.
- **There is no per-client identity anywhere in this model.** A token that authorizes a call does not resolve to a "device," a "client," or any other identifier the server tracks — nothing is stamped onto an Event to say which credential wrote it (§4.8's Event shape has no such field). Any valid token has full read/write access to every project the instance hosts; isolating two teams' data means running two separate KnoTrack instances (consistent with the single-tenant-per-deployment model, §5.1), not scoping tokens within one instance.
- **Rotation is manual, by design — there is no in-band rotation API in v1:** generate a new token (`npm run generate-token`); append it to `KNOTRACK_API_TOKENS` and redeploy (both old and new tokens are now valid simultaneously, which is what makes this zero-downtime); update each MCP client's configuration to the new token, one at a time; once every client is confirmed updated, remove the old token from `KNOTRACK_API_TOKENS` and redeploy again. There is no automatic expiry; operators are advised to rotate on a schedule of their choosing, or immediately (accepting the resulting downtime for not-yet-updated clients) if a token is suspected leaked.
- Adapter credentials (a GitHub personal access token, a Linear API key) are supplied inline as **input** to `kt_register_project`'s `adapters` field (§4.1) — the only way to set or rotate them, since there is no separate "update credentials" tool. They are encrypted with AES-256-GCM via Node's built-in `node:crypto` (key from the `KNOTRACK_ENCRYPTION_KEY` environment variable — deliberately not `pgcrypto`, so the decryption key never has to transit the Postgres connection or appear in a slow-query log or a web-based SQL console) before being persisted into the `adapters` table's `encrypted_credential` column (a packed `iv || authTag || ciphertext` blob), and are **never** included in any MCP tool's output — every tool returns only ids and derived fields, never the credential itself. Rotating the encryption key itself (as opposed to a leaked adapter credential) is a separate, operator-run, offline procedure via `npm run rotate-encryption-key`, which re-encrypts every stored credential under a new key inside one transaction.
- No cross-project data leakage: every scoped lookup (track/item/event/decision under a `project_id`) is validated as belonging to that project before being returned or mutated (§4.0), even though a single instance is single-tenant — this protects an installer who registers more than one unrelated project on the same instance.

### 5.4 MCP client compatibility (stated exactly, not oversold)

KnoTrack targets the **MCP 2026-07-28 spec**, which is stateless: no tool relies on server-side session memory, and every call is self-contained with explicit IDs (§4.0). Compatibility with specific clients was established as follows, and this is stated plainly rather than implied to be more thorough than it is:

- **Claude Code / Cowork, Windsurf, Codex CLI, LM Studio:** compatibility verified via review of each project's own documentation and changelogs against the 2026-07-28 spec's requirements (tool call shape, error content format, stateless session handling). This is **not** equivalent to live end-to-end testing against a running instance of each client.
- **Goose and Hermes** (the two open-source clients in this list): compatibility was additionally checked by inspecting each project's pinned MCP SDK dependency version in its own repository, to confirm it implements the 2026-07-28 spec's tool-call and error semantics rather than an older, stateful predecessor.
- **In no case** was live, interactive testing performed against every listed client. Behavior may vary by client in ways documentation review would not surface (e.g., how a client renders a structured error object, or how it handles a very large tool-result payload). This is an accepted v1 limitation, not a hidden one — it is stated here so an installer knows exactly what "supported" means for their specific client, and so a client-specific bug report is understood as plausible, not surprising.

### 5.5 Hosting: the honest cost/limitation profile of each documented path

None of the three deploy targets is "free forever with zero catches." Each is stated here exactly as it is, so an installer is never surprised after the fact — **and, separately from cost, only one of the three has actually been built and verified as of 2026-09-07:** Railway (`docs/ROADMAP.md` T3, done 2026-09-05; runbook at `docs/deploy/railway.md`). Render+Supabase and Fly.io are target designs the maintainers intend to verify (`docs/ROADMAP.md` T7.1/T7.2), not paths anyone has deployed KnoTrack to yet — the mechanics and catches below are accurate to each platform's own documentation, but unlike the Railway row they have not been exercised against a running instance.

| Target | Cost at start | The actual catch | Verified against a real deploy? |
|---|---|---|---|
| **Render + Supabase** | Free, no card required | Render's free web service tier has **no persistent disk** (the app server itself must be stateless; all persistence must live in Supabase's Postgres, never on local disk). Supabase's free-tier project **pauses after 7 days of inactivity** and must be manually resumed from the dashboard before KnoTrack will respond again. | **No** — planned, not yet built (`T7.1`, blocked). |
| **Railway + Postgres** | Free trial | The free trial converts to a **paid plan after roughly 30 days, or sooner if usage exceeds about $5** of trial credit — whichever comes first. This is a real, near-term cost, not a permanently free tier. | **Yes** — deployed, health-checked, and called by two independent MCP clients (`T3`, `T4`). |
| **Fly.io** | Paid from day one | Requires a **credit card at signup**, even though usage may fall within a low-cost or nominally free usage band. In exchange, a Fly.io deployment **never sleeps/pauses** the way the other two free paths do, which matters for a tool other agents call into unpredictably throughout the day. | **No** — planned, not yet built (`T7.2`, blocked). |

An installer who wants a deployment that is proven to work today should choose Railway, at least until `T7.1`/`T7.2` close. Of the two unverified options, an installer who wants zero card entry and can tolerate an occasional manual "wake the database" click would choose Render+Supabase; one who wants a deployment that is always instantly responsive, and is willing to pay from the start, would choose Fly.io — but either choice currently means being the first to actually exercise that path end-to-end.

### 5.6 No telemetry

KnoTrack does not collect or transmit usage analytics, crash reports, or any other telemetry from a self-hosted instance back to the maintainers, under any configuration. This is a design commitment, not a missing feature: it follows directly from the self-hosted, installer-owned distribution model (§7, §6.4) and from the license's attribution-only expectation (Apache 2.0 + NOTICE) rather than any data-sharing expectation.

---

## 6. Success Metrics

Because KnoTrack collects no central telemetry (§5.6), every metric below is something an installer can observe **on their own instance**, not something the maintainers aggregate across installs. This section describes what "working" looks like from inside one deployment, plus one manual, maintainer-run QA metric for the deploy paths themselves.

1. **Session-summary discipline.** Fraction of working sessions that end with a real `kt_record_session_summary` call carrying a genuine, non-empty `summary_text`, versus sessions where no call was made at all. (The schema enforces non-empty, not a specific minimum length beyond that — see §4.8.) A rising fraction over time indicates the tool has become part of the actual workflow rather than a novelty. (Observable by the installer directly from their own Event table.)
2. **Drift trend, not drift count.** The ratio of `SEQUENCE_SKIP` flags (§4.11) that get resolved, or simply stop recurring as work catches up to its declared order, versus flags that persist open across repeated checks. A tool that's working sees this trend toward resolved, not toward a silently accumulating pile of open flags nobody looks at.
3. **`kt_get_next_steps` actually consulted before work starts.** Correlating ordinary HTTP/application access logs for `kt_get_next_steps` calls against the timestamps of subsequent Item status changes and Events — if items are consistently touched shortly after a next-steps call recommended them, the advisory loop is being used as intended. Note this is derived from access logs, not from the Event table, because `kt_get_next_steps` is deliberately side-effect-free (§4.5) and creates no Event of its own.
4. **Rendered-roadmap freshness, if the caller chooses to persist it.** `kt_render_roadmap` (§4.12) has no notion of a target file — it returns rendered content as a string — so freshness is only measurable if and however the calling agent chooses to persist that string (e.g. committing it into the repo as `ROADMAP.md`). Where an installer adopts that convention, the time elapsed between a DB state change and the next commit of the rendered content is still a meaningful trust signal for the snapshot; where they don't, this metric simply doesn't apply to that installation.
5. **Adapter usage where configured.** For a project with GitHub or Linear credentials configured (a row exists in `adapters` for that project/type — §5.3), the frequency of successful sync calls relative to manual, un-synced Item creation — if a project has an adapter configured but the sync tools are never (or, in this build, cannot yet be — §4.13/§4.14) exercised, that's a signal the adapter isn't earning its complexity for that installer.
6. **Time-to-first-registered-project per deploy path (maintainer-run, manual QA).** Not automated telemetry — a manual checklist the maintainers run themselves against each of the three deploy targets in §5.5, timing from `git clone` to a successful first `kt_register_project` call. Target: under 30 minutes on each path, re-verified whenever a deploy guide or dependency changes. As of 2026-09-07 this has only actually been run for Railway (well under target — see `docs/ROADMAP.md` T3/T4); Render+Supabase and Fly.io have a draft runbook (`docs/deploy/client-verification-runbook.md`) but it hasn't actually been run end-to-end yet, so this metric doesn't apply to them until `T7.1`/`T7.2` close.

---

## 7. Out of Scope for v1

- **Work dispatch or orchestration of any kind.** No tool in this document assigns, triggers, queues, or executes work against any agent, CI system, or external runner. `kt_get_next_steps` is advisory only (§4.5); this boundary is treated as permanent product identity, not a temporary v1 gap — see §2.2.
- **Team/multi-user auth beyond a single shared bearer-token pool.** There is no role-based access control, no SSO/OAuth login flow, no per-device or per-user token identity, and no concept of a restricted or read-only token in v1 — every valid token accepted by an instance (§5.3) has full read/write access to every project it hosts, and the server has no way to tell which configured token a given call used. A small team (persona in §3.2) shares one instance and, in practice, one token per developer drawn from the same pool, all with equal privileges. Formal per-user roles and scoped/read-only tokens are a natural v2 addition once real multi-user usage shows which restrictions are actually wanted.
- **Real-time push UI.** `kt_get_project_status` and all other read tools are pull/poll-based only. There is no WebSocket/SSE channel, no live-updating dashboard, and no in-app or external notification (Slack, email, etc.) fired when drift is detected — a human or agent must proactively call a status/drift tool to find out. A future web UI, if built, would poll these same MCP tools rather than requiring a new push mechanism.
- **Automatic conflict resolution for adapter sync, and bidirectional/bulk sync generally.** `kt_sync_to_github` and `kt_sync_to_linear` (§4.13, §4.14 — not yet implemented in this build) are each a single, scoped, one-way push per call, with no bulk import, no direction choice, and no merge logic for the case where the same piece of work has diverged independently on both sides.
- **Automatic parsing of arbitrary local roadmap/spec file formats, and importing existing GitHub/Linear issues.** As stated in §1.3, KnoTrack does not itself ingest free-text planning documents from a local folder; the calling agent reads them and populates Tracks/Items via `kt_create_track`/`kt_create_item`. The GitHub and Linear adapters are one-way pushes of existing KnoTrack state outward, not an import path — there is no tool in v1 that pulls GitHub Issues or Linear Issues into KnoTrack Items.
- **Centralized, maintainer-run hosting or analytics.** There is no multi-tenant SaaS version of KnoTrack, and no telemetry collection of any kind (§5.6). "Open source, self-hosted" is the whole distribution model for v1, not a stepping stone the PRD assumes will change.
- **A standalone chat or web-app interface.** KnoTrack in v1 is purely an MCP tool surface. Whatever conversational interface a user experiences is provided entirely by the calling agent harness (Claude Code, Windsurf, etc.), not by KnoTrack itself.
- **Deleting or editing Tracks, Items, Events, or Decisions.** No tool in the 14 supports deletion or retroactive editing of any entity (status changes on Items are the one intentional exception, via `kt_update_item_status`, and are themselves append-only in effect since prior states remain visible in Event history). Corrections happen by recording new, forward-looking data (a new Decision, a new status), never by rewriting old rows.

---

## 8. Glossary

- **Project** — The top-level entity representing one software project KnoTrack has been pointed at. Identified by a `source_type` (`github`, `linear`, or `local`) and a `source_ref` whose meaning depends on `source_type` (a repo, a Linear team, or a local filesystem path) — not by a `root_path`/`repo_url` pair. All other entities belong to exactly one Project.
- **Track** — A grouping of related work within a Project (roughly: an epic or workstream), with a stored `status` of `on_track`, `pivot_pending`, `blocked`, or `done`, and optional declared dependencies on other Tracks. `status` is written by exactly two tools — `kt_create_track` (initial value) and `kt_record_decision` (→ `pivot_pending`) — never derived at read time, and as of this build there is no tool that moves a track back out of `blocked` or `pivot_pending` (§4.4, §4.9).
- **Item** — A single, discrete piece of work inside a Track. Has a `sequence_position` (its declared order within the Track), a stored `status` (`pending`, `in_progress`, `blocked`, `done` — written only by `kt_update_item_status`), and optional dependencies on other Items, restricted in v1 to items within the same Track. There is no `file_patterns` field on Items in this build.
- **Event** — An append-only log entry created by `kt_record_session_summary`, recording what happened in a session: a `summary_text`, the files touched, and any items touched. Events carry no per-caller identity (§5.3) and no self-reported drift opinion — drift is structural only. Events are never edited or deleted once written; recording one also re-runs the drift-detector's rules scoped to that Event's track.
- **Decision** — An explicit, append-only record of an intentional pivot or plan change, scoped to one Track: a `title`, a `rationale` (why), and a `what_changed` description (what concretely changed). Decisions are never inferred from a status change or a boolean flag — they only exist because `kt_record_decision` was deliberately called with real content. Recording one moves its Track to `pivot_pending` (§4.9); it does not directly suppress any drift flag, though it changes the input to the `UNDOCUMENTED_DECISION` flag specifically.
- **Drift** — A structurally-computed mismatch between the declared plan and what actually happened, never from a self-reported opinion. Evaluated against a six-type flag catalog (`STALE_TRACK`, `DEPENDENCY_GAP`, `SEQUENCE_SKIP`, `UNDOCUMENTED_DECISION`, `ORPHAN_ITEM`, `SYNC_DRIFT` — full definitions in §4.11); as of this build, only `SEQUENCE_SKIP` is actually raised anywhere, via `kt_record_session_summary`'s scoped per-track re-check, since the full-project `kt_check_drift` scan is not yet implemented.
- **Adapter** — A per-project integration to an external source-of-truth system (GitHub or Linear) that provides one-way, per-track push sync, gated on the server holding the relevant credential for that project (a row in the `adapters` table) — not a separate "enable this adapter" flag. Adapter credentials are always server-side only, never passed through any MCP tool's output. Both sync tools are registered with their real contracts but not yet implemented in this build (§4.13, §4.14).
- **Advisory** — The general operating principle behind `kt_get_next_steps` and, in effect, every other KnoTrack tool: the system recommends, tracks, and reports, but never assigns, dispatches, or blocks a human/agent's actual actions.

---

## 9. Appendix: Data Model Reference

*Full rewrite as of the 2026-09-07 reconciliation (see the document header): an earlier draft of this appendix hand-copied a DDL block that had drifted substantially from the schema actually built — wrong table names, wrong columns, wrong nullability, and an entity (a database-backed auth-token store) that was never built at all. The table below matches the schema after the full applied migration set (`migrations/001_init.sql` through `005_tracks_sync_timestamps.sql`) exactly — several documented columns (`adapters.key_version`, `tracks.last_github_sync_at`/`last_linear_sync_at`) are added by migrations 004 and 005, not present in 001 alone. `docs/DATABASE_SCHEMA.md` remains the canonical, authoritative reference for constraints, indexes, and design rationale; this is a summary for implementer convenience, not a second source of truth to keep in sync by hand.*

Track- and item-level dependencies are stored as **join tables** (`track_dependencies(track_id, depends_on_track_id, created_at)`, `item_dependencies(item_id, depends_on_item_id, created_at)`), not array columns — despite `depends_on_track_ids`/`depends_on_item_ids` appearing as arrays in every tool's JSON input/output (§4), that shape is assembled at the API layer from the join tables, not stored directly on `tracks`/`items`.

**Project**
`id (uuid pk)`, `name (text)`, `source_type (text — "github" | "linear" | "local")`, `source_ref (text, nullable)`, `created_at (timestamptz)`, `updated_at (timestamptz)`, `deleted_at (timestamptz, nullable — soft delete)`.

**Adapter**
`id (uuid pk)`, `project_id (uuid fk)`, `type (text — "github" | "linear")`, `encrypted_credential (bytea — a packed iv(12 bytes) || authTag(16 bytes) || ciphertext blob, §5.3)`, `config (jsonb — non-secret metadata only, e.g. {"owner": "acme", "repo": "widgets"})`, `key_version (integer, default 1 — which generation of `KNOTRACK_ENCRYPTION_KEY` encrypted this row; bumped by the key-rotation process, §5.3)`, `created_at`. Unique on `(project_id, type)` — at most one adapter row per project per type.

**Track**
`id (uuid pk)`, `project_id (uuid fk)`, `title (text)`, `status (text, CHECK-constrained: on_track|pivot_pending|blocked|done, default on_track — written only by kt_create_track and kt_record_decision, §4.4/§4.6/§4.9)`, `source_doc_ref (text, nullable)`, `last_github_sync_at (timestamptz, nullable)`, `last_linear_sync_at (timestamptz, nullable — both added for the future SYNC_DRIFT rule, §4.11; not yet written by anything, since the sync tools aren't implemented)`, `created_at`, `updated_at`. Track-level dependencies: a `track_dependencies (track_id, depends_on_track_id, created_at)` join table, no self-dependency allowed. There is no `description` column.

**Item**
`id (uuid pk)`, `track_id (uuid fk)`, `title (text)`, `sequence_position (integer, not unique per track_id — see §4.7's shift-on-insert behavior)`, `status (text, CHECK-constrained: pending|in_progress|done|blocked, default pending — written only by kt_update_item_status, §4.10)`, `created_at`, `updated_at`. Item-level dependencies: an `item_dependencies (item_id, depends_on_item_id, created_at)` join table restricted at the application layer (§4.7) to pairs within the same track. There is no `description`, `file_patterns`, or `external_ref` column.

**Event** (append-only: the `UPDATE` grant may be optionally revoked at the DB role level, §5.2 — not automatic; `DELETE` stays grantable for the documented hard-delete/legal-erasure path)
`id (uuid pk)`, `project_id (uuid fk)`, `track_id (uuid fk, nullable)`, `summary_text (text)`, `files_touched (jsonb array, default [])`, `items_touched (jsonb array, default [])`, `created_at`. There is no `client_id`, `self_reported_drift`, `self_reported_drift_note`, or `structural_drift_result` column — none of those concepts exist in this build (§5.3, §4.8).

**Decision** (append-only, same optional-revoke note as Event)
`id (uuid pk)`, `project_id (uuid fk)`, `track_id (uuid fk, nullable)`, `title (text)`, `rationale (text)`, `what_changed (text)` — non-emptiness on `rationale`/`what_changed` is enforced by the tool's input schema, not a DB constraint — `created_at`. There is no `item_ids` column and no `created_by` — Decisions in this build carry no per-caller identity, consistent with §5.3's shared-token auth model.

**Drift flag**
`id (uuid pk)`, `project_id (uuid fk)`, `track_id (uuid fk, nullable)`, `item_id (uuid fk, nullable)`, `kind (text, CHECK-constrained: "out_of_sequence" | "orphan_file_change")`, `detail (jsonb)`, `raised_at`, `resolved_at (nullable — null means open)`. The richer `flag_type`/`severity`/`status` fields shown in tool outputs (§4.2, §4.11) are derived from this narrower stored shape at read time — `severity` derived from `kind` (not stored), `status` = `"open"` when `resolved_at IS NULL` else `"resolved"`. `kind` maps to `flag_type` per-value, not uniformly onto §4.11's six-entry catalog: `"out_of_sequence"` maps to the catalog's `SEQUENCE_SKIP`, but `"orphan_file_change"` maps to a reserved `ORPHAN_FILE_CHANGE` flag_type that is outside that six-entry catalog and is not raised by any code path in this build — see `docs/DATABASE_SCHEMA.md` for the exact mapping.

**Auth tokens** — **not used by v1's auth path, even though the table itself exists.** Bearer tokens are a flat, comma-separated list in the `KNOTRACK_API_TOKENS` environment variable, compared directly against each request (§5.3); nothing about a token — an issuance record, a label, a device association, a revocation timestamp — is ever persisted to Postgres, and no code path queries `api_tokens`. The table (`id`, `project_id` nullable fk, `token_hash`, `label`, `created_at`, `last_used_at`, unique on `token_hash`) is created by `migrations/001_init.sql` and remains in the schema as a legacy, unused artifact — see `docs/DATABASE_SCHEMA.md` for its exact definition — rather than something that was never built.
