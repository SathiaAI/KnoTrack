# KnoTrack — Product Requirements Document

**Version:** 1.0
**Status:** Approved for implementation
**Date:** 2026-08-23
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
- **GitHub-backed projects:** `kt_sync_to_github` provides structured import of Issues into Items via the GitHub API — no free-text parsing involved.
- **Linear-backed projects:** `kt_sync_to_linear` does the same against the Linear API.

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

**What KnoTrack gives them:** one shared self-hosted instance (single Postgres database, single server) with one bearer token issued per developer's device; `kt_record_session_summary` after every session gives a shared Event log; `kt_check_drift` gives a structural, not self-reported, view of whether anyone stepped out of declared sequence; `kt_sync_to_linear` keeps Items lined up with the team's actual tickets.

### 3.3 The open-source installer who is not the original author

Found KnoTrack on GitHub, is not a KnoTrack contributor, and just wants to run it for their own unrelated project. They have no interest in reading the source. Their pain: most self-hosted OSS tools either require Docker/Kubernetes expertise or turn out to have a hidden paid dependency once you're three steps into setup.

**What KnoTrack gives them:** three documented, tested deploy paths (Render+Supabase, Railway+Postgres, Fly.io) with the real cost/limitation of each stated up front (§5.5), an Apache 2.0 license with a NOTICE file so they know exactly what attribution is required, and a setup path that ends in a working bearer token and a first `kt_register_project` call with no undocumented step in between.

---

## 4. Functional Requirements

### 4.0 Conventions used throughout this section

- All 14 tools are exposed over MCP following the **2026-07-28 stateless MCP spec**: every call is self-contained and includes every ID it needs (`project_id`, and further-scoped IDs as applicable). No tool relies on "the last project you registered," "the current track," or any other server-side session memory — a stateless server has none to rely on, and KnoTrack's implementation must not simulate it via in-memory globals either, since MCP clients may (and do) round-robin calls across reconnecting transports.
- IDs are plain UUIDs (`gen_random_uuid()`, no prefix) — see `docs/DATABASE_SCHEMA.md` for the canonical column definitions.
- All tool inputs are validated against a JSON Schema with `additionalProperties: false`. Unknown fields are rejected, not ignored — this catches client-side typos immediately instead of silently dropping data.
- All tool outputs are returned as a single JSON object inside the MCP tool result's text content block.
- Errors are structured: `{ "code": "<ERROR_CODE>", "message": "<human-readable>", "details": { ... } }`. Defined codes used across tools: `VALIDATION`, `NOT_FOUND`, `CONFLICT`, `CYCLE_DETECTED`, `ADAPTER_NOT_CONFIGURED`, `UPSTREAM_ERROR`, `UNAUTHORIZED`.
- `project_id` is a required input on every tool except `kt_register_project`. Passing a `track_id`, `item_id`, `event_id`, or `decision_id` that exists but does not belong to the given `project_id` is always a `NOT_FOUND` error (scoped lookup, not global lookup) — this prevents one project's IDs from ever being usable to read or write another project's data, which matters once a single instance hosts more than one project.
- No tool call is retried automatically by the server; MCP clients are responsible for their own retry policy. All writes are wrapped in a single database transaction, so a failed call never leaves partial rows (see §5.2).
- Pagination: v1 does not paginate `kt_list_tracks` or track/item listings — the realistic scale for one project's structured plan (tens of tracks, hundreds of items) does not need it. The one genuinely unbounded log, Events, is controlled instead by a `since` timestamp (on `kt_check_drift`) and a hard cap (`event_limit`, max 100, on `kt_get_project_status`) rather than cursor pagination — this is deliberately simpler than pagination for a dataset this shape, and is a stated v1 scope decision, not an oversight.

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
- Credentials in `adapters.github`/`adapters.linear` are encrypted (AES-256-GCM, §5) before being persisted to the separate `adapter_credentials` table; they are never echoed back in this or any other tool's output.
- If encrypting or persisting a supplied adapter credential fails (e.g. a crypto/database error), the whole call fails with a generic `500 INTERNAL_ERROR` rather than partially succeeding — this is a hard failure, not a soft-fail-with-warnings path. There is no "requested an adapter with no credential configured" case, since credentials are supplied inline on the call rather than resolved from server-side configuration.

**Acceptance criteria:**
- **Given** no project exists with `source_type: "github", source_ref: "acme/widgets"`, **when** `kt_register_project` is called with `name: "Acme API", source_type: "github", source_ref: "acme/widgets"`, **then** the call succeeds and returns a new `project_id`.
- **Given** a project already exists with `source_type: "github", source_ref: "acme/widgets"`, **when** `kt_register_project` is called again with the same `source_type`/`source_ref` and a different `name`, **then** the call succeeds, the existing row's `name` is updated, and the same `project_id` as before is returned.
- **Given** a valid `adapters.github.personal_access_token` is supplied, **when** `kt_register_project` is called, **then** the call succeeds and the token is stored encrypted in `adapter_credentials`, never appearing in the tool's output or in any other tool's output.

### 4.2 `kt_get_project_status`

**Description:** The primary "what's going on with this project" overview call.

**Inputs:** `project_id` (required), `event_limit` (integer, optional, default 10, max 100).

**Output:**
```
{
  project: { project_id, name, root_path, repo_url, adapters_enabled },
  tracks: [ { track_id, title, status, item_counts: { total, not_started, in_progress, blocked, done } } ],
  drift_flags: [ ...same shape as kt_check_drift's finding entries... ],
  drift_last_checked_at: "<ISO8601 timestamp, or null>",
  recent_events: [ { event_id, track_id, summary, files_touched, self_reported_drift, created_at } ]  // most recent first, capped at event_limit
}
```

**Business rules / edge cases:**
- `drift_flags` and `drift_last_checked_at` reflect the **cached result of the most recent `kt_check_drift` or `kt_record_session_summary` call** for this project — this call does **not** itself recompute drift. *Rationale: recomputing structural drift on every status read would make the single most frequently called tool also the most expensive one; freshness is bounded and visible instead via `drift_last_checked_at`, and any caller who needs a guaranteed-fresh answer calls `kt_check_drift` directly.* If neither has ever been called for this project, `drift_flags` is `[]` and `drift_last_checked_at` is `null`.
- A project with zero tracks returns `tracks: []` — this is valid, not an error.
- `project_id` not found → `NOT_FOUND`.

**Acceptance criteria:**
- **Given** a project with 3 tracks and no drift check has ever run, **when** `kt_get_project_status` is called, **then** `drift_flags` is `[]` and `drift_last_checked_at` is `null`.
- **Given** `kt_check_drift` was run 2 hours ago and found 1 sequence-drift item, **when** `kt_get_project_status` is called now (with no new drift check run in between), **then** `drift_flags` contains that same 1 finding and `drift_last_checked_at` equals the timestamp of that earlier check, not "now."
- **Given** an unknown `project_id`, **when** `kt_get_project_status` is called, **then** the call fails with `NOT_FOUND`.

### 4.3 `kt_list_tracks`

**Description:** List a project's tracks, optionally filtered by status.

**Inputs:** `project_id` (required), `status` (optional enum: `on_track | pivot_pending | blocked | done`), `include_items` (boolean, optional, default `false`).

**Output:** `{ tracks: [ { track_id, title, status, depends_on: [track_id...], items?: [...] } ] }` — `items` present only when `include_items: true`, in `sequence_position` order.

**Business rules / edge cases:**
- Invalid `status` value → `VALIDATION` naming the four allowed values.
- No tracks match the filter → `{ tracks: [] }`, not an error.

**Acceptance criteria:**
- **Given** a project with 2 `on_track` and 1 `blocked` track, **when** `kt_list_tracks` is called with `status: "blocked"`, **then** exactly 1 track is returned.
- **Given** `status: "in_progress"` (not a valid Track status — that's an Item status), **when** `kt_list_tracks` is called, **then** the call fails with `VALIDATION`.
- **Given** `include_items: true`, **when** `kt_list_tracks` is called, **then** each returned track includes its `items` array ordered ascending by `sequence_position`.

### 4.4 `kt_get_track`

**Description:** Full detail for one track: its items and the resolved dependency graph.

**Inputs:** `project_id` (required), `track_id` (required).

**Output:**
```
{
  track: { track_id, title, description, status, depends_on: [track_id...] },
  items: [ { item_id, title, status, sequence_position, depends_on: [item_id...], file_patterns: [...] } ],
  dependency_graph: {
    track_edges: [ { from: track_id, to: track_id } ],       // "from depends_on to"
    item_edges: [ { from: item_id, to: item_id } ]
  },
  dangling_dependencies: [ { item_id, invalid_dependency_id } ]
}
```

**Business rules / edge cases:**
- `track_id` must belong to `project_id`; if it belongs to a different project or doesn't exist, `NOT_FOUND`.
- Any `depends_on` reference (track- or item-level) that points at an ID no longer resolvable is **not** a hard failure for the whole call — it is collected into `dangling_dependencies` (or the track-level equivalent) so the rest of the track's real data is still usable. *Rationale: since v1 has no delete tool for tracks/items, dangling references should be rare, but a typo'd ID at creation time (§4.6/§4.7) should degrade gracefully on read rather than making the whole track unreadable.*
- `item_edges` in `dependency_graph` include cross-track item dependencies (an item may declare `depends_on` on an item that lives in a different track) — item-level dependencies are independent of track-level dependencies and are never required to mirror each other. *Rationale: forcing every cross-track item link to also be declared as a track-level dependency would make fine-grained sequencing (e.g., "this one item needs that one item, but the two tracks are otherwise independent") impossible to express without an unwanted broader constraint.*

**Acceptance criteria:**
- **Given** track T has 4 items in sequence positions 1, 2, 3, 4, **when** `kt_get_track` is called, **then** `items` is returned in that exact order.
- **Given** item A (in track T) declares `depends_on: [B]` where B lives in a different track T2, **when** `kt_get_track` is called for T, **then** `dependency_graph.item_edges` includes `{ from: A, to: B }` even though T does not declare `depends_on: [T2]`.
- **Given** an item's `depends_on` array contains an ID that does not exist in the database, **when** `kt_get_track` is called, **then** the call still succeeds, and `dangling_dependencies` contains that pair.
- **Given** a `track_id` that exists but belongs to a different `project_id` than the one supplied, **when** `kt_get_track` is called, **then** the call fails with `NOT_FOUND`.

### 4.5 `kt_get_next_steps`

**Description:** The advisory ranking tool. Returns unblocked (or newly-unblocked) items in a deterministic priority order with a stated rationale for each. **This tool never assigns, dispatches, or executes anything, and it is the one guarantee in this document that most directly defines what KnoTrack is not.**

**Inputs:** `project_id` (required), `track_id` (optional — scope to one track; omitted means whole project), `limit` (integer, optional, default 5, max 25), `include_blocked_tracks` (boolean, optional, default `false`).

**Output:**
```
{
  advisory_notice: "This is a ranked recommendation only. KnoTrack does not assign, dispatch, or execute this work. The calling agent or human decides what to do next.",
  ranked_items: [
    {
      item_id, track_id, title,
      unblocked: true,
      blocking_dependencies: [],
      rationale: "All declared dependencies are done; track is on_track; next in declared sequence (position 3)."
    }
  ],
  blocking_summary: [ { item_id, title, blocking_dependencies: [item_id...] } ]   // present when ranked_items is empty
}
```

**Ranking algorithm (deterministic, must be reproduced exactly):**
1. Exclude all items whose track's status is `blocked` or `done`, unless `include_blocked_tracks: true`.
2. Among remaining items with status `not_started` or `blocked`, compute `unblocked` = true iff every ID in the item's `depends_on` refers to an item with status `done`.
3. Sort by: (a) track status priority — `on_track` before `pivot_pending`; (b) `unblocked: true` before `unblocked: false`; (c) `sequence_position` ascending as the final tie-break.
4. Truncate to `limit`.
5. `rationale` is generated from the same facts used to sort (track status, unblocked state, sequence position) — it is not a free-form LLM summary, it is a templated sentence built from the structural facts, so it is exactly reproducible from the same DB state.

**Business rules / edge cases:**
- `advisory_notice` is present, verbatim, on **every** response — it is not optional and not omittable by any input combination.
- This call performs **no writes**. It creates no Event, updates no cached drift state, and has zero side effects on the database. *Rationale: this is the concrete mechanism, not just a policy statement, by which "advisory only" is enforced — there is nothing in this call path that could be mistaken for a dispatch action.*
- If no unblocked items exist anywhere in scope, `ranked_items` is `[]` and `blocking_summary` lists the top blocked items and what's blocking them, so the caller has something actionable even when nothing is ready.
- A project or track with zero items returns `ranked_items: []` and no `blocking_summary` (nothing is blocked because nothing exists).

**Acceptance criteria:**
- **Given** track T is `on_track` with item A (`not_started`, no deps, position 1) and item B (`not_started`, depends on A, position 2), **when** `kt_get_next_steps` is called, **then** `ranked_items[0].item_id == A`, `A.unblocked == true`, and B is either absent or ranked after A with `unblocked: false`.
- **Given** every item in the project is blocked on an undone dependency, **when** `kt_get_next_steps` is called, **then** `ranked_items` is `[]` and `blocking_summary` is non-empty.
- **Given** any valid input, **when** `kt_get_next_steps` is called, **then** the response's top-level object contains the field `advisory_notice` with the exact text specified above, and no Event row is created as a result of the call (verified by comparing the project's Event count before and after the call).
- **Given** track T2 is `blocked` and contains an otherwise-unblocked item C, **when** `kt_get_next_steps` is called with default `include_blocked_tracks: false`, **then** C does not appear in `ranked_items`; **when** called again with `include_blocked_tracks: true`, **then** C appears, ranked after any items from `on_track` tracks.

### 4.6 `kt_create_track`

**Description:** Create a new Track within a project.

**Inputs:** `project_id` (required), `title` (required, 1–200 chars), `description` (optional), `depends_on` (optional array of `track_id`, must already exist in the same project), `initial_status` (optional enum, default `"on_track"`).

**Output:** `{ track_id, title, description, status, depends_on, created_at, warnings: [] }`

**Business rules / edge cases:**
- Track-level `depends_on` must not introduce a cycle in the project's track-dependency graph. Cycle detection is a DFS over all tracks in the project (existing + the one being created); on detection, the call fails with `CYCLE_DETECTED` and `details.cycle` lists the track IDs in cycle order.
- Any `depends_on` entry referencing a track_id that does not exist in this project → `VALIDATION`.
- Duplicate `title` across tracks in the same project is **allowed** (titles are not unique) but the response includes a `warnings` entry naming the other track_id(s) sharing that title, since two same-named tracks are legal but likely to confuse a human later.

**Acceptance criteria:**
- **Given** track A already exists, **when** `kt_create_track` is called for track B with `depends_on: [A]`, **then** B is created successfully with `depends_on: [A]`.
- **Given** track A depends on track B, **when** `kt_create_track` is called to create a new "track" that is actually just B being re-declared to depend on A (i.e., would close A→B→A), **then** the call fails with `CYCLE_DETECTED`.
- **Given** a track named "Auth Rework" already exists, **when** another track named "Auth Rework" is created, **then** creation succeeds and the response's `warnings` names the existing track.

### 4.7 `kt_create_item`

**Description:** Create a new Item inside a Track.

**Inputs:** `project_id`, `track_id` (required), `title` (required), `description` (optional), `sequence_position` (optional integer; auto-assigned as `max(existing positions in this track) + 1` if omitted), `depends_on` (optional array of `item_id`, may reference items in other tracks within the same project), `file_patterns` (optional array of glob strings), `initial_status` (optional enum, default `"not_started"`).

**Output:** `{ item_id, track_id, title, sequence_position, depends_on, file_patterns, status, created_at }`

**Business rules / edge cases:**
- `sequence_position` is **not** required to be unique per track at the database level (see `docs/DATABASE_SCHEMA.md`'s `items` table). If the caller supplies a position already taken within that track, KnoTrack shifts every existing item at or after that position up by one (an atomic `UPDATE ... WHERE track_id = $1 AND sequence_position >= $2` inside the same transaction as the insert) so the new item lands at the requested position without ever producing a duplicate. *Rationale: rejecting the call would push the renumbering decision onto every caller; shifting keeps `sequence_position` values always contiguous and unique in practice without requiring a database-level uniqueness constraint that would make concurrent reordering race-prone.*
- `depends_on` cycle detection runs over the **whole project's item-dependency graph** (not scoped to one track), since items can depend cross-track; on cycle, `CYCLE_DETECTED` with the cycle path.
- Each entry in `file_patterns` is validated as syntactically valid glob syntax; an invalid entry → `VALIDATION` naming which pattern failed.
- `depends_on` referencing an item not in this project → `VALIDATION`.

**Acceptance criteria:**
- **Given** track T has items at positions 1 and 2, **when** `kt_create_item` is called with no `sequence_position`, **then** the new item is assigned position 3.
- **Given** track T has items at positions 1, 2, and 3, **when** `kt_create_item` is called with `sequence_position: 2`, **then** the call succeeds, the new item takes position 2, and the existing items previously at positions 2 and 3 now sit at 3 and 4 respectively.
- **Given** `file_patterns: ["src/**/*.ts", "[invalid"]`, **when** `kt_create_item` is called, **then** the call fails with `VALIDATION` naming `"[invalid"` as the offending pattern.
- **Given** item A depends on item B and B depends on item C, **when** `kt_create_item` is called to create/update C such that it would depend on A, **then** the call fails with `CYCLE_DETECTED`.

### 4.8 `kt_record_session_summary`

**Description:** The call an agent makes at the end of a working session. Appends an immutable Event and, inline, runs the same structural drift computation as `kt_check_drift`, scoped to this project (and `track_id` if given).

**Inputs:** `project_id` (required), `track_id` (optional), `item_ids` (optional array of `item_id`), `files_touched` (required array of strings, may be `[]`), `summary` (required string, min 10 chars — a single word or empty string is rejected), `self_reported_drift` (optional boolean), `self_reported_drift_note` (optional string).

Note: `client_id` is never a body parameter — it is resolved server-side from the authenticated bearer token (§5.3) and stamped onto the Event automatically, so a client cannot claim to be a different device than the one it authenticated as.

**Output:**
```
{
  event_id, created_at,
  drift_result: { ...identical shape to kt_check_drift's output, scoped to this call... },
  warnings: []   // e.g. files_outside_project_root
}
```

**Business rules / edge cases:**
- `files_touched` is a required field (the array itself, not its contents) — an agent must explicitly pass `[]` for a planning-only session rather than omitting the field, so "no files changed" is always a deliberate statement, not an accidental gap.
- `summary` shorter than 10 characters is rejected with `VALIDATION` — this is a deliberate floor against meaningless session notes like "did stuff."
- This call **always** performs the full structural drift computation (§4.11's two categories) and (a) stores the result attached to this Event, and (b) updates the project's cached `drift_flags` / `drift_last_checked_at` that `kt_get_project_status` reads.
- **`self_reported_drift` is recorded for audit color only and never substitutes for, suppresses, or overrides the structural result.** If `self_reported_drift: false` but the structural check independently finds sequence or untracked-work drift, the response's `drift_result` still reports that drift. Conversely, if `self_reported_drift: true` but the structural check finds nothing, `drift_result`'s structural finding lists remain empty and the self-report appears only in `drift_result.self_reported_notes`.
- `item_ids` referencing items outside this project → `VALIDATION`.
- Paths in `files_touched` that fall outside the project's `root_path` (for local-folder projects only; not checked for repo_url-only projects, since there is no local root to compare against) are **not** rejected — legitimate monorepo/shared-file work happens — but are surfaced in `warnings.files_outside_project_root`.

**Acceptance criteria:**
- **Given** a valid session with `files_touched: ["src/auth.ts"]` and `summary: "Implemented password reset flow"`, **when** `kt_record_session_summary` is called, **then** an Event is created, `drift_result` is present, and `kt_get_project_status`'s next call reflects the updated `drift_last_checked_at`.
- **Given** `summary: "ok"`, **when** `kt_record_session_summary` is called, **then** the call fails with `VALIDATION` (below the 10-character floor).
- **Given** `self_reported_drift: false` and an item in `item_ids` that is `in_progress` with an undone dependency and no covering Decision, **when** `kt_record_session_summary` is called, **then** `drift_result.sequence_drift` still contains that item's finding — the self-report does not suppress it.
- **Given** `files_touched: []` (explicit empty array) and a valid `summary`, **when** `kt_record_session_summary` is called, **then** the call succeeds (an explicit no-file-changes session is valid).
- **Given** `files_touched` omitted entirely, **when** `kt_record_session_summary` is called, **then** the call fails with `VALIDATION` (the field itself, not just its contents, is required).

### 4.9 `kt_record_decision`

**Description:** Record an explicit, human/agent-authored pivot or decision. Never inferred — a Decision only exists because this tool was called with real rationale text.

**Inputs:** `project_id` (required), `title` (required), `rationale` (required, non-empty), `what_changed` (required, non-empty — concrete description, e.g. "Track B reprioritized ahead of Track A because the client moved up the Track B deadline"), `track_id` (optional), `item_ids` (optional array).

**Output:** `{ decision_id, title, rationale, what_changed, track_id, item_ids, created_at }`

**Business rules / edge cases:**
- `rationale` and `what_changed` being empty or whitespace-only strings → `VALIDATION`. This is the entire point of the entity: a Decision must carry real explanatory content, never a bare boolean.
- Decisions are immutable once created — there is no update or delete tool for Decisions in v1. A correction is made by recording a **new** Decision whose `rationale` references the earlier one by ID or description. *Rationale: this keeps the v1 API surface minimal; a formal `supersedes_decision_id` link is a natural, low-risk v2 addition once real usage shows people want it, but is not required for the core guarantee (an auditable, append-only decision trail) to hold in v1.*
- A Decision that names a `track_id` or includes an `item_id` in `item_ids` **suppresses future sequence-drift flags** for that track/item in any `kt_check_drift` or `kt_record_session_summary` call whose drift computation runs **after** this Decision's `created_at`. It is **not retroactive** — drift findings already recorded on earlier Events remain in the historical record unchanged; only future computations are affected.

**Acceptance criteria:**
- **Given** `rationale: ""`, **when** `kt_record_decision` is called, **then** the call fails with `VALIDATION`.
- **Given** item X currently shows `SEQUENCE_DRIFT` under `kt_check_drift` because its dependency isn't done, **when** a Decision is recorded with `item_ids: [X]` and non-empty rationale/what_changed, **then** a subsequent `kt_check_drift` call no longer includes X in `sequence_drift`.
- **Given** the same scenario, **when** the *original* Event/finding that flagged X (recorded before the Decision existed) is inspected via `kt_get_project_status`'s historical `recent_events`, **then** that earlier flag is unchanged — the Decision does not rewrite history.

### 4.10 `kt_update_item_status`

**Description:** Change an Item's status. Never blocks on drift — advisory warnings only.

**Inputs:** `project_id`, `item_id` (required), `new_status` (required enum: `not_started | in_progress | blocked | done`), `note` (optional).

**Output:** `{ item_id, old_status, new_status, sequence_warning: boolean, details: { unmet_dependencies: [item_id...] } | null }`

**Business rules / edge cases:**
- This call is **idempotent**: setting an item to its current status is allowed and returns success (with `sequence_warning` recomputed, not cached).
- If `new_status` is `in_progress` or `done` and at least one `depends_on` item is not `done`, and no Decision covers this item (per §4.9's suppression rule), the call **still succeeds** — `sequence_warning: true` is returned, but the status change is never rejected. *Rationale: KnoTrack is advisory-only end to end; a tool that refuses a status update because of a sequencing opinion would be making an execution decision, which is explicitly out of scope (§2.2).*
- This call does **not** run the full structural drift check or write a cached `drift_flags` update — that only happens via `kt_check_drift` or `kt_record_session_summary`. The `sequence_warning` here is a lightweight, synchronous, single-item check for immediate feedback, not the authoritative drift record.
- `item_id` not belonging to `project_id` → `NOT_FOUND`.

**Acceptance criteria:**
- **Given** item A has an undone dependency and no covering Decision, **when** `kt_update_item_status` is called with `new_status: "done"`, **then** the call succeeds, `new_status == "done"`, and `sequence_warning == true` with the unmet dependency listed.
- **Given** the same scenario, **then** the status is actually persisted as `"done"` — the warning never prevents the write.
- **Given** item A is already `"done"`, **when** `kt_update_item_status` is called again with `new_status: "done"`, **then** the call succeeds (idempotent), returning the same status with `sequence_warning` recomputed against current data.

### 4.11 `kt_check_drift`

**Description:** Standalone, on-demand structural drift check. This is the authoritative computation that both this tool and `kt_record_session_summary` share.

**Inputs:** `project_id` (required), `track_id` (optional, scopes the check), `since` (optional ISO8601 timestamp; default = the `checked_at` of the last drift computation for this exact scope, or the project's creation time if none exists yet).

**Output:**
```
{
  checked_at: "<ISO8601>",
  scope: { project_id, track_id },
  sequence_drift: [ { item_id, track_id, unmet_dependencies: [item_id...] } ],
  untracked_work_drift: [ { file_path, event_id, occurred_at } ] | null,
  untracked_work_coverage: "evaluated" | "not_evaluated_no_file_patterns",
  self_reported_notes: [ { event_id, self_reported_drift_note, occurred_at } ]
}
```

**Drift categories (exact, reproducible definitions):**

1. **`SEQUENCE_DRIFT`** — an Item whose current `status` is `in_progress` or `done`, where at least one ID in its `depends_on` refers to an item whose `status` is not `done`, **and** no Decision exists (with `created_at` at or before the check's `checked_at`) whose `track_id` or `item_ids` covers this item. Each finding lists the specific unmet dependency IDs.
2. **`UNTRACKED_WORK_DRIFT`** — a file path appearing in `files_touched` of any Event within the scoped time window (`since` → now) that does not match any Item's `file_patterns` glob anywhere in the project. This category is only computed (`untracked_work_coverage: "evaluated"`) if **at least one** Item in the project has a non-empty `file_patterns` array; otherwise `untracked_work_drift` is `null` and `untracked_work_coverage: "not_evaluated_no_file_patterns"`. *Rationale: most projects will not bother declaring `file_patterns` on every item; evaluating this category against a project with zero declared patterns would flag every single file ever touched as "untracked," which is noise, not signal — so the check honestly reports "not evaluated" instead of returning a false positive avalanche.*

- `self_reported_notes` collects any Event in the window with `self_reported_drift: true`, listed purely for human/agent color — **never** merged into or treated as equivalent to `sequence_drift` / `untracked_work_drift` findings.
- **Side effect:** calling this tool updates the project's cached `drift_flags` / `drift_last_checked_at` (the same cache `kt_get_project_status` reads), scoped to whatever `track_id` scope was passed (a project-wide call updates the project-wide cache; a track-scoped call updates only that track's portion). *Rationale: an explicit, authoritative drift check that didn't update the cached status view would be silently ignored by `kt_get_project_status`, which defeats the purpose of running it on demand.*

**Acceptance criteria:**
- **Given** item A (`in_progress`) depends on item B (`not_started`) and no Decision covers A, **when** `kt_check_drift` is called, **then** `sequence_drift` contains one entry for A listing B as an unmet dependency.
- **Given** the same scenario but a Decision covering A was recorded before this check's `checked_at`, **when** `kt_check_drift` is called, **then** `sequence_drift` does not include A.
- **Given** no Item in the project has a non-empty `file_patterns`, **when** `kt_check_drift` is called, **then** `untracked_work_drift` is `null` and `untracked_work_coverage == "not_evaluated_no_file_patterns"`.
- **Given** Item C declares `file_patterns: ["src/auth/**"]` and an Event in the scoped window touched `src/payments/checkout.ts` (matching no item's patterns), **when** `kt_check_drift` is called, **then** `untracked_work_drift` includes that file/event pair.
- **Given** an Event in the window has `self_reported_drift: true` but the file it touched matches a declared pattern and no sequence issue exists, **when** `kt_check_drift` is called, **then** that Event's note appears in `self_reported_notes` and nowhere in `sequence_drift` or `untracked_work_drift`.
- **Given** a prior drift check ran and updated the cache, **when** `kt_get_project_status` is called immediately after a new `kt_check_drift` call, **then** its `drift_flags`/`drift_last_checked_at` reflect the new call's results, not the older cached ones.

### 4.12 `kt_render_roadmap`

**Description:** Pure-function generation of `ROADMAP.md` from current database state. Never a write target for humans or agents — always fully regenerated, never merged with prior content.

**Inputs:** `project_id` (required), `output_path` (optional). Default: if the project has a `root_path`, defaults to `<root_path>/ROADMAP.md`. If the project has no `root_path` (repo_url-only), `output_path` is meaningless for a local write, so the tool instead returns the markdown as a string (see Output).

**Output:**
- If a filesystem write occurred: `{ written: true, path, bytes_written, overwrote_untracked_file: boolean }`
- If no local filesystem target exists (`root_path` absent and no `output_path` given): `{ written: false, markdown: "<full rendered content>" }`

**Rendering rules:**
- Content: Tracks grouped by status (`on_track`, `pivot_pending`, `blocked`, `done` — in that order), each with its Items in `sequence_position` order showing status and any declared dependencies, followed by a reverse-chronological Decisions log section, followed by a footer line: `<!-- Generated by KnoTrack at <ISO8601> — do not hand-edit; this file is fully overwritten on every render. -->`.
- The renderer **never reads existing file content to merge** — it always overwrites completely. This is required, not incidental: `ROADMAP.md` is a projection, not a source of truth, and merging would risk silently preserving stale hand-edits as if they were still authoritative.
- If `output_path` already exists but does **not** contain the KnoTrack footer marker (i.e., it looks like a file KnoTrack did not generate), the render still proceeds and overwrites it, but the response sets `overwrote_untracked_file: true` so the caller/human is told, after the fact, that a non-KnoTrack file was replaced. *Rationale: KnoTrack has no way to ask for confirmation mid-call in a stateless MCP model, and refusing to render at all would make the tool useless the first time it's pointed at a path with an old hand-written roadmap already sitting there — so it proceeds, but never silently.*

**Acceptance criteria:**
- **Given** a project with `root_path` set and no `output_path` given, **when** `kt_render_roadmap` is called, **then** `<root_path>/ROADMAP.md` is written and the response has `written: true`.
- **Given** a project with only `repo_url` set (no `root_path`) and no `output_path` given, **when** `kt_render_roadmap` is called, **then** no file is written; the response has `written: false` and `markdown` contains the full rendered content.
- **Given** `<root_path>/ROADMAP.md` already exists with hand-written content and no KnoTrack footer, **when** `kt_render_roadmap` is called, **then** the file is fully overwritten and the response has `overwrote_untracked_file: true`.
- **Given** `<root_path>/ROADMAP.md` was itself generated by a previous `kt_render_roadmap` call (footer present) and contains stale content, **when** `kt_render_roadmap` is called again after DB state changed, **then** the file is fully overwritten to match current DB state (no partial merge of old and new content).

### 4.13 `kt_sync_to_github`

**Description:** Optional, off-by-default adapter for structured import/export against GitHub Issues. Only active if `adapters_enabled` includes `"github"` for the project and the server has a configured `GITHUB_TOKEN`.

**Inputs:** `project_id` (required), `direction` (required enum: `pull_issues_as_items | push_track_as_milestone | push_item_as_issue`), `track_id` (required for `push_track_as_milestone`; optional filter for `pull_issues_as_items`), `item_id` (required for `push_item_as_issue`), `github_repo` (optional override; defaults to the project's `repo_url`).

**Output (by direction):**
- `pull_issues_as_items`: `{ items_created: [item_id...], items_skipped_duplicate: [github_issue_url...], errors: [{ github_issue_url, error }] }`
- `push_track_as_milestone`: `{ github_milestone_url }`
- `push_item_as_issue`: `{ github_issue_url }`

**Business rules / edge cases:**
- If the project's `adapters_enabled` does not include `"github"`, **or** the server has no `GITHUB_TOKEN` configured, the call fails immediately with `ADAPTER_NOT_CONFIGURED` and `details` naming exactly which precondition failed and how to fix it. This never silently no-ops.
- Each call is **one-directional only** — there is no automatic bidirectional merge or conflict resolution in v1. *Rationale: conflict resolution between two independently-editable sources of truth (GitHub Issues and KnoTrack Items) is a nontrivial UX and correctness problem; resolving it is deferred to v2, and forcing every sync to be an explicit, single-direction call avoids silent data loss in the meantime.*
- Deduplication on repeated `pull_issues_as_items` calls uses a dedicated `external_ref` field on Item (format: `"github:<issue_url>"`), so pulling the same GitHub issue twice does not create a duplicate Item — it is instead reported in `items_skipped_duplicate`.
- A bulk `pull_issues_as_items` call reports **partial results**, not all-or-nothing: if 8 of 10 issues import successfully and 2 fail (e.g., malformed issue body), the call still returns `items_created` for the 8 plus a per-issue `errors` array for the 2, rather than rejecting the whole batch.
- GitHub API unreachable or rate-limited → `UPSTREAM_ERROR`, including a `retry_after` field when GitHub's response provides one.

**Acceptance criteria:**
- **Given** a project without `"github"` in `adapters_enabled`, **when** `kt_sync_to_github` is called, **then** the call fails with `ADAPTER_NOT_CONFIGURED` naming that the adapter isn't enabled for this project.
- **Given** the adapter is enabled and configured, and GitHub issue #42 was already pulled in as an Item, **when** `pull_issues_as_items` is called again over the same range, **then** issue #42 appears in `items_skipped_duplicate`, not `items_created`.
- **Given** a batch pull where 2 of 10 issues have malformed bodies, **when** `pull_issues_as_items` runs, **then** the response contains 8 entries in `items_created` and 2 in `errors`, and the call as a whole reports success (not a total failure).
- **Given** GitHub returns a 403 rate-limit response, **when** any direction is attempted, **then** the call fails with `UPSTREAM_ERROR` and `details.retry_after` set from GitHub's response header.

### 4.14 `kt_sync_to_linear`

**Description:** Optional, off-by-default adapter for structured import/export against Linear. Only active if `adapters_enabled` includes `"linear"` for the project and the server has a configured `LINEAR_API_KEY`. Linear's "Project" maps to KnoTrack's Track; Linear's "Issue" maps to KnoTrack's Item.

**Inputs:** `project_id` (required), `direction` (required enum: `pull_issues_as_items | push_track_as_project | push_item_as_issue`), `track_id` (required for `push_track_as_project`; optional filter for `pull_issues_as_items`), `item_id` (required for `push_item_as_issue`), `linear_team_id` (optional override).

**Output (by direction):**
- `pull_issues_as_items`: `{ items_created: [item_id...], items_skipped_duplicate: [linear_issue_id...], errors: [{ linear_issue_id, error }] }`
- `push_track_as_project`: `{ linear_project_url }`
- `push_item_as_issue`: `{ linear_issue_url }`

**Business rules / edge cases (mirrors §4.13 exactly, with Linear-specific specifics):**
- Same `ADAPTER_NOT_CONFIGURED` precondition behavior, naming `"linear"` / `LINEAR_API_KEY` specifically.
- Same one-directional-per-call rule; same partial-result behavior on bulk pulls; same `UPSTREAM_ERROR` behavior for unreachable/rate-limited Linear API calls.
- Deduplication reuses the same Item `external_ref` field as the GitHub adapter, with a `"linear:<issue_id>"` prefix — the two adapters share one field on Item without collision because each writes its own distinguishable prefix, and an Item can in principle carry a synced reference from at most one adapter direction at a time per pull (re-running the other adapter's pull against an item that already has a `github:` ref does not overwrite it with a `linear:` ref; it is treated as a new, separate Item, since a single Item is not modeled as multi-sourced in v1).

**Acceptance criteria:**
- **Given** a project without `"linear"` in `adapters_enabled`, **when** `kt_sync_to_linear` is called, **then** the call fails with `ADAPTER_NOT_CONFIGURED`.
- **Given** Linear issue `ISS-101` was already pulled in, **when** `pull_issues_as_items` runs again over the same team, **then** `ISS-101` appears in `items_skipped_duplicate`.
- **Given** `push_track_as_project` is called for track T, **when** the call succeeds, **then** the response contains a `linear_project_url` and no Item/Track data in KnoTrack's own database is mutated as a side effect of this push (push directions are exports; they do not loop back and rewrite the local record in v1).

---

## 5. Non-Functional Requirements

### 5.1 Deployment and data model

- Self-hosted, single-tenant per instance: one Postgres database, one server process (or process group) per installer, per instance. No shared multi-tenant service exists or is offered by the maintainers.
- Because each instance is single-tenant, there is no per-request tenant-isolation logic to get wrong — every row in the database belongs to installer's own instance by construction. This is a deliberate simplification of the security model that a multi-tenant SaaS version would not get to make.
- Three documented deploy targets, each with a step-by-step guide shipped in the repo: Render + Supabase, Railway + Postgres, Fly.io. See §5.5 for the honest cost/limitation profile of each — none is hidden.

### 5.2 Reliability

- No formal uptime SLA is offered or meaningful for a self-hosted, installer-operated tool — uptime is the installer's own operational responsibility. KnoTrack's reliability requirements instead focus on **data integrity**, which the maintainers do control through the software's design:
  - Event and Decision rows are strictly append-only at the application layer: the codebase must never issue an `UPDATE` or `DELETE` against the `events` or `decisions` tables under any code path. This is enforced by code review discipline plus a database-level revoke of `UPDATE`/`DELETE` privileges on those two tables for the application's DB role, so even a bug cannot silently rewrite history.
  - Every multi-statement write across the 14 tools (e.g., `kt_record_session_summary`'s Event insert + drift-cache update; `kt_create_item`'s position check + insert) is wrapped in a single database transaction. A failure partway through never leaves partial rows.
  - Performance target: `kt_check_drift` and `kt_get_next_steps` must complete in under 2 seconds for a project with up to 500 Items and 5,000 Events, measured on the smallest documented deploy tier (Render free). This bound is chosen because it is the ceiling of a realistic single-project, single-team scale (§4.0's pagination rationale) — not an enterprise-scale target.

### 5.3 Security

- **Bearer tokens, one per client device**, held client-side only in that tool's own MCP config (e.g., an environment variable or config field the harness reads to set the `Authorization: Bearer <token>` header). Tokens are opaque random 256-bit values.
- Token issuance is **not** an MCP tool — it is a server-side CLI/admin command run by the installer directly on the server (`knotrack create-token --project <id> --label <device-name>`), because a stateless MCP tool call would need a token to already exist in order to be authenticated in the first place. Issuance prints the raw token exactly once; it is stored server-side only as a salted hash (bcrypt or argon2id) and is never retrievable or re-displayed after creation. Revocation is `knotrack revoke-token <token-id>`, also a server-side CLI command.
- Every one of the 14 MCP tool calls requires a valid, unrevoked bearer token. The token resolves to a `client_id` server-side; this resolved `client_id`, not any client-supplied field, is what gets stamped onto Events (§4.8), preventing a client from claiming to be a different device than the one it authenticated as.
- Adapter credentials (`GITHUB_TOKEN`, `LINEAR_API_KEY`) are configured **only** via server-side environment variables or a server-side config file. They are never accepted as a parameter on any MCP tool, and never appear in any MCP tool's input or output schema — this guarantees they can never transit through a client-side MCP config file or end up inside an agent's context window.
- No cross-project data leakage: every scoped lookup (track/item/event/decision under a `project_id`) is validated as belonging to that project before being returned or mutated (§4.0), even though a single instance is single-tenant — this protects an installer who registers more than one unrelated project on the same instance.

### 5.4 MCP client compatibility (stated exactly, not oversold)

KnoTrack targets the **MCP 2026-07-28 spec**, which is stateless: no tool relies on server-side session memory, and every call is self-contained with explicit IDs (§4.0). Compatibility with specific clients was established as follows, and this is stated plainly rather than implied to be more thorough than it is:

- **Claude Code / Cowork, Windsurf, Codex CLI, LM Studio:** compatibility verified via review of each project's own documentation and changelogs against the 2026-07-28 spec's requirements (tool call shape, error content format, stateless session handling). This is **not** equivalent to live end-to-end testing against a running instance of each client.
- **Goose and Hermes** (the two open-source clients in this list): compatibility was additionally checked by inspecting each project's pinned MCP SDK dependency version in its own repository, to confirm it implements the 2026-07-28 spec's tool-call and error semantics rather than an older, stateful predecessor.
- **In no case** was live, interactive testing performed against every listed client. Behavior may vary by client in ways documentation review would not surface (e.g., how a client renders a structured error object, or how it handles a very large tool-result payload). This is an accepted v1 limitation, not a hidden one — it is stated here so an installer knows exactly what "supported" means for their specific client, and so a client-specific bug report is understood as plausible, not surprising.

### 5.5 Hosting: the honest cost/limitation profile of each documented path

None of the three documented deploy targets is "free forever with zero catches." Each is stated here exactly as it is, so an installer is never surprised after the fact:

| Target | Cost at start | The actual catch |
|---|---|---|
| **Render + Supabase** | Free, no card required | Render's free web service tier has **no persistent disk** (the app server itself must be stateless; all persistence must live in Supabase's Postgres, never on local disk). Supabase's free-tier project **pauses after 7 days of inactivity** and must be manually resumed from the dashboard before KnoTrack will respond again. |
| **Railway + Postgres** | Free trial | The free trial converts to a **paid plan after roughly 30 days, or sooner if usage exceeds about $5** of trial credit — whichever comes first. This is a real, near-term cost, not a permanently free tier. |
| **Fly.io** | Paid from day one | Requires a **credit card at signup**, even though usage may fall within a low-cost or nominally free usage band. In exchange, a Fly.io deployment **never sleeps/pauses** the way the other two free paths do, which matters for a tool other agents call into unpredictably throughout the day. |

An installer who wants zero card entry and can tolerate an occasional manual "wake the database" click should choose Render+Supabase. An installer who wants a deployment that is always instantly responsive, and is willing to pay from the start, should choose Fly.io. Railway is a reasonable middle ground for roughly a month of genuinely free evaluation before a real billing decision is required.

### 5.6 No telemetry

KnoTrack does not collect or transmit usage analytics, crash reports, or any other telemetry from a self-hosted instance back to the maintainers, under any configuration. This is a design commitment, not a missing feature: it follows directly from the self-hosted, installer-owned distribution model (§7, §6.4) and from the license's attribution-only expectation (Apache 2.0 + NOTICE) rather than any data-sharing expectation.

---

## 6. Success Metrics

Because KnoTrack collects no central telemetry (§5.6), every metric below is something an installer can observe **on their own instance**, not something the maintainers aggregate across installs. This section describes what "working" looks like from inside one deployment, plus one manual, maintainer-run QA metric for the deploy paths themselves.

1. **Session-summary discipline.** Fraction of working sessions that end with a real `kt_record_session_summary` call carrying a substantive (>10 char, non-generic) `summary`, versus sessions where no call was made at all. A rising fraction over time indicates the tool has become part of the actual workflow rather than a novelty. (Observable by the installer directly from their own Event table.)
2. **Drift trend, not drift count.** The ratio of sequence-drift findings that get an explicit covering Decision recorded soon after (a real "yes, we meant to do that") versus findings that recur unaddressed across multiple `kt_check_drift` calls. A tool that's working sees this ratio trend toward "explained," not toward "silently ignored" or "count trending to zero because no one runs the check anymore."
3. **`kt_get_next_steps` actually consulted before work starts.** Correlating ordinary HTTP/application access logs for `kt_get_next_steps` calls against the timestamps of subsequent Item status changes and Events — if items are consistently touched shortly after a next-steps call recommended them, the advisory loop is being used as intended. Note this is derived from access logs, not from the Event table, because `kt_get_next_steps` is deliberately side-effect-free (§4.5) and creates no Event of its own.
4. **`ROADMAP.md` freshness.** Time elapsed between a DB state change (new track/item, status change) and the next `kt_render_roadmap` call, measurable via git commit timestamps (for repo-backed projects) or file mtime (for local-only projects). A small, stable gap means the rendered roadmap is trustworthy as a snapshot; a growing gap means it's being ignored and the team is back to trusting stale docs.
5. **Adapter usage where enabled.** For projects with `"github"` or `"linear"` in `adapters_enabled`, the frequency of successful sync calls relative to manual, un-synced Item creation — if a project enables an adapter but never uses it, that's a signal the adapter isn't earning its complexity for that installer.
6. **Time-to-first-registered-project per deploy path (maintainer-run, manual QA).** Not automated telemetry — a manual checklist the maintainers run themselves against each of the three deploy targets in §5.5, timing from `git clone` to a successful first `kt_register_project` call. Target: under 30 minutes on each path, re-verified whenever a deploy guide or dependency changes.

---

## 7. Out of Scope for v1

- **Work dispatch or orchestration of any kind.** No tool in this document assigns, triggers, queues, or executes work against any agent, CI system, or external runner. `kt_get_next_steps` is advisory only (§4.5); this boundary is treated as permanent product identity, not a temporary v1 gap — see §2.2.
- **Team/multi-user auth beyond per-device bearer tokens.** There is no role-based access control, no SSO/OAuth login flow, and no concept of a restricted or read-only token in v1 — every valid bearer token on an instance has full read/write access to every project that instance hosts. A small team (persona in §3.2) shares one instance with one token per developer device, all with equal privileges. Formal per-user roles and scoped/read-only tokens are a natural v2 addition once real multi-user usage shows which restrictions are actually wanted.
- **Real-time push UI.** `kt_get_project_status` and all other read tools are pull/poll-based only. There is no WebSocket/SSE channel, no live-updating dashboard, and no in-app or external notification (Slack, email, etc.) fired when drift is detected — a human or agent must proactively call a status/drift tool to find out. A future web UI, if built, would poll these same MCP tools rather than requiring a new push mechanism.
- **Automatic conflict resolution for bidirectional adapter sync.** `kt_sync_to_github` and `kt_sync_to_linear` are one-directional per call (§4.13, §4.14); there is no merge logic for the case where the same piece of work has diverged independently on both sides.
- **Automatic parsing of arbitrary local roadmap/spec file formats.** As stated in §1.3, KnoTrack does not itself ingest free-text planning documents from a local folder; the calling agent reads them and populates Tracks/Items via `kt_create_track`/`kt_create_item`. Only GitHub and Linear have structured import paths in v1.
- **Centralized, maintainer-run hosting or analytics.** There is no multi-tenant SaaS version of KnoTrack, and no telemetry collection of any kind (§5.6). "Open source, self-hosted" is the whole distribution model for v1, not a stepping stone the PRD assumes will change.
- **A standalone chat or web-app interface.** KnoTrack in v1 is purely an MCP tool surface. Whatever conversational interface a user experiences is provided entirely by the calling agent harness (Claude Code, Windsurf, etc.), not by KnoTrack itself.
- **Deleting or editing Tracks, Items, Events, or Decisions.** No tool in the 14 supports deletion or retroactive editing of any entity (status changes on Items are the one intentional exception, via `kt_update_item_status`, and are themselves append-only in effect since prior states remain visible in Event history). Corrections happen by recording new, forward-looking data (a new Decision, a new status), never by rewriting old rows.

---

## 8. Glossary

- **Project** — The top-level entity representing one software project KnoTrack has been pointed at. Identified by a `root_path` (local folder), a `repo_url` (GitHub), or both. All other entities belong to exactly one Project.
- **Track** — A grouping of related work within a Project (roughly: an epic or workstream), with a `status` of `on_track`, `pivot_pending`, `blocked`, or `done`, and optional declared dependencies on other Tracks.
- **Item** — A single, discrete piece of work inside a Track. Has a `sequence_position` (its declared order within the Track), a `status` (`not_started`, `in_progress`, `blocked`, `done`), optional dependencies on other Items (which may live in different Tracks), and optional `file_patterns` used by drift detection to associate real file changes with declared work.
- **Event** — An append-only log entry created by `kt_record_session_summary`, recording what a client (an agent session) did: which files were touched, a human-readable summary, and an optional self-reported drift opinion. Events are never edited or deleted once written; they are the raw material structural drift detection is computed from.
- **Decision** — An explicit, append-only record of an intentional pivot or plan change: a `title`, a `rationale` (why), and a `what_changed` description (what concretely changed). Decisions are never inferred from a status change or a boolean flag — they only exist because `kt_record_decision` was deliberately called with real content. A Decision covering a Track or Item suppresses future sequence-drift findings for it, but never rewrites past findings.
- **Drift** — A structurally-computed mismatch between the declared plan and what actually happened, evaluated by `kt_check_drift` (and inline by `kt_record_session_summary`) from the Event log, never from a self-reported opinion alone. Two kinds exist in v1: **sequence drift** (an Item was advanced to `in_progress`/`done` while a declared dependency was still undone, with no covering Decision) and **untracked-work drift** (a file was touched in a session that matches no Item's declared `file_patterns` anywhere in the project — only evaluated when at least one Item has declared patterns).
- **Adapter** — An optional, per-project, off-by-default integration to an external source-of-truth system (GitHub Issues or Linear) that provides structured, one-directional import/export of Tracks and Items, gated on both the project explicitly enabling it and the server holding the relevant credential. Adapter credentials are always server-side only, never passed through any MCP tool.
- **Advisory** — The general operating principle behind `kt_get_next_steps` and, in effect, every other KnoTrack tool: the system recommends, tracks, and reports, but never assigns, dispatches, or blocks a human/agent's actual actions.

---

## 9. Appendix: Data Model Reference

For implementer convenience, the full field list per entity (Postgres-flavored types; `depends_on`-style arrays are stored as JSONB arrays of ID strings or a join table, implementer's choice, as long as the cycle-detection and cross-track behaviors in §4.6/§4.7 hold):

**Project**
`id (uuid pk)`, `name (text, unique citext)`, `root_path (text, nullable)`, `repo_url (text, nullable)`, `adapters_enabled (text[])`, `created_at (timestamptz)`, `updated_at (timestamptz)`

**Track**
`id (uuid pk)`, `project_id (uuid fk)`, `title (text)`, `description (text, nullable)`, `status (enum: on_track|pivot_pending|blocked|done)`, `depends_on (uuid[] of track ids)`, `created_at`, `updated_at`

**Item**
`id (uuid pk)`, `track_id (uuid fk)`, `title (text)`, `description (text, nullable)`, `status (enum: not_started|in_progress|blocked|done)`, `sequence_position (integer, unique per track_id)`, `depends_on (uuid[] of item ids, cross-track allowed)`, `file_patterns (text[], nullable)`, `external_ref (text, nullable — "github:<url>" or "linear:<id>")`, `created_at`, `updated_at`

**Event** (append-only: no UPDATE/DELETE grants at the DB role level)
`id (uuid pk)`, `project_id (uuid fk)`, `track_id (uuid fk, nullable)`, `item_ids (uuid[], nullable)`, `client_id (text, resolved from bearer token, not client-supplied)`, `files_touched (text[])`, `summary (text)`, `self_reported_drift (boolean, nullable)`, `self_reported_drift_note (text, nullable)`, `structural_drift_result (jsonb — the drift_result computed inline at write time)`, `created_at`

**Decision** (append-only: no UPDATE/DELETE grants at the DB role level)
`id (uuid pk)`, `project_id (uuid fk)`, `track_id (uuid fk, nullable)`, `item_ids (uuid[], nullable)`, `title (text)`, `rationale (text, non-empty)`, `what_changed (text, non-empty)`, `created_by (text, client_id from bearer token)`, `created_at`

**Auth token store** (server-side only; never exposed via any MCP tool)
`id (text pk)`, `project_id (uuid fk, nullable — a token may be scoped instance-wide in v1 since there is no RBAC, see §7)`, `label (text — device name)`, `token_hash (text, bcrypt/argon2id)`, `created_at`, `revoked_at (timestamptz, nullable)`
