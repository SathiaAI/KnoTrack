# KnoTrack Roadmap

KnoTrack is a self-hosted MCP server that gives an AI coding agent (and its
human) a shared, durable view of project status, sequencing, and drift — it
is explicitly **not** an orchestrator and never dispatches work. This
document plans the build of KnoTrack itself, phased into eight Tracks.

**This roadmap has a second job.** Once the KnoTrack server exists and runs,
KnoTrack will register itself as a KnoTrack project
(`kt_register_project`), and every Track and Item below will be created
in that instance via `kt_create_track` / `kt_create_item` — so KnoTrack
tracks the build of KnoTrack from that point forward (see "Dogfood cutover"
below, and the seeding procedure at the end of this document). Because this
file *is* the seed data, every Item is written as a single, checkable
deliverable with one acceptance criterion, and every dependency — within a
Track, across Tracks, or on a specific prior Item — is stated explicitly
rather than implied by ordering.

## Legend

- **Track ID**: `T1`–`T8`. **Item ID**: `T<n>.<m>`, e.g. `T3.4`.
- **Track status** uses the real `tracks.status` enum from the schema
  (`docs/... DB schema`, `migrations/001_init.sql`): `on_track`,
  `pivot_pending`, `blocked`, `done`. All Tracks start `blocked` except
  the one Track nothing else is waiting on.
- **Item status** uses the real `items.status` enum: `pending`,
  `in_progress`, `done`, `blocked`. Every Item below starts `pending`
  unless noted; T1's items are already substantially satisfied in reality
  (the specs exist) and will be backfilled to `done` at cutover (`T8.3`).
- **`depends_on`** on a Track lists prior Track(s) that must be `done`
  first, mapping to the `track_dependencies` table. **`depends_on`** on an
  Item lists prior Item(s) — possibly in another Track — that must be
  `done` first, mapping to the `item_dependencies` table.

## The 14 MCP tools

Referenced throughout by name; this is the full and final canonical set for
v1, as fixed in the TRD/Architecture/Test-Cases docs. (An earlier draft of
this roadmap used a different, non-canonical tool list — corrected here;
if you're diffing against history, everything below is the fix.)

| # | Tool | Purpose |
|---|------|---------|
| 1 | `kt_register_project` | Register (or upsert) a project KnoTrack will track |
| 2 | `kt_get_project_status` | Roll-up view: tracks, items, open drift flags, recent events |
| 3 | `kt_list_tracks` | List a project's tracks, optionally filtered by status |
| 4 | `kt_get_track` | Track detail: items + dependency graph |
| 5 | `kt_get_next_steps` | **Advisory only** ranked list of unblocked items — never writes anything |
| 6 | `kt_create_track` | Create a Track under a project |
| 7 | `kt_create_item` | Create an Item under a Track |
| 8 | `kt_record_session_summary` | Append a session's summary + files/items touched; runs the drift check inline |
| 9 | `kt_record_decision` | Log an explicit pivot/decision against a track; sets that track's stored status to `pivot_pending` |
| 10 | `kt_update_item_status` | Change an Item's status |
| 11 | `kt_check_drift` | Return open drift flags for a project |
| 12 | `kt_render_roadmap` | Generate a roadmap document from current DB state (pure read, never a write target) |
| 13 | `kt_sync_to_github` | Push an Item to a linked GitHub Issue |
| 14 | `kt_sync_to_linear` | Push an Item to a linked Linear Issue |

Issuing bearer tokens (`api_tokens`) is an operator action done via an
admin CLI/script at deploy time, not one of the 14 MCP tools. There is no
`kt_update_track`, `kt_list_items`, `kt_get_session_history`, or
`kt_archive_project` tool: track status is a stored column that only ever
changes as a side effect of `kt_create_track` (initial value) and
`kt_record_decision` (→ `pivot_pending`) — never set directly; an item's
containing track already comes back from `kt_get_track`, so no separate
listing tool is needed; recent events are already part of
`kt_get_project_status`'s response; and project archival/deletion is
explicitly out of scope for v1 per `PRD.md` §7.

---

## T1 — Spec sign-off

**Status:** `on_track` (the only Track not `blocked` initially — nothing
else can start before this one).
**depends_on:** none.

1. **T1.1 — PRD finalized and approved.** Acceptance: PRD is committed
   under `docs/`, and the maintainer's sign-off is recorded (approving PR
   review or a dated note in `docs/SIGNOFF.md`).
2. **T1.2 — TRD finalized and approved.** Acceptance: TRD is committed and
   approved; every functional requirement in the PRD maps to at least one
   TRD section.
3. **T1.3 — Architecture doc finalized.** Acceptance: architecture doc is
   committed, including a component diagram and the deployment topology
   for all three target platforms (Railway, Render+Supabase, Fly.io).
4. **T1.4 — DB schema finalized.** Acceptance: `migrations/001_init.sql`
   (+ its `.down.sql`) is committed, covers every entity in the TRD
   (`projects`, `adapters`, `tracks`, `track_dependencies`, `items`,
   `item_dependencies`, `events`, `decisions`, `api_tokens`,
   `drift_flags`), and `docs/DATABASE_SCHEMA.md` documents the design
   choices referenced in the migration's header comment.
5. **T1.5 — Test case matrix authored for all 14 MCP tools.** Acceptance:
   a committed test-case doc lists at least one happy-path and one
   failure-path case per tool in the table above (26+ cases total),
   cross-checked against the TRD's tool contracts.
6. **T1.6 — Cross-document consistency pass.** Acceptance: a single
   reviewer pass confirms the PRD, TRD, architecture doc, DB schema, and
   test-case matrix use consistent naming, entities, and tool signatures
   with zero open discrepancies; sign-off recorded in
   `docs/SIGNOFF.md`. depends_on: `T1.1`, `T1.2`, `T1.3`, `T1.4`, `T1.5`.

---

## T2 — Core MCP server (local, Postgres)

**Status:** `blocked`.
**depends_on:** `T1`.

Ten of the 14 tools are fully implemented here. `kt_sync_to_github`,
`kt_sync_to_linear`, `kt_record_session_summary`, and `kt_check_drift` get
working stub implementations now (correct request/response shape, no
external API calls, no real drift heuristics) — full behavior for the
sync tools lands in T5, and for the two drift-related tools in T6.

1. **T2.1 — Local Postgres migrations runnable.** Acceptance: `migrate up`
   against a clean local Postgres 13+ instance creates every table in
   `001_init.sql` with no errors; `migrate down` cleanly reverses it.
   depends_on: `T1.4`, `T1.6`.
2. **T2.2 — `kt_register_project` implemented + unit-tested.** Acceptance:
   inserts (or upserts on `(source_type, source_ref)`) a row into
   `projects`; unit tests cover the T1.5 happy-path and failure-path cases
   for this tool. depends_on: `T2.1`.
3. **T2.3 — `kt_create_track` implemented + unit-tested.** Acceptance:
   inserts a row into `tracks` (status `on_track`, or `blocked` if any
   listed `depends_on` track is not yet `done`) scoped to a project,
   writes the `depends_on` list to `track_dependencies`, rejects a
   dependency cycle with `409`; unit-tested per T1.5. depends_on: `T2.2`.
4. **T2.4 — `kt_create_item` implemented + unit-tested.** Acceptance:
   inserts a row into `items` (default status `pending`) scoped to a
   track, accepts a `depends_on` list written to `item_dependencies`,
   rejects a dependency cycle with `409`; unit-tested per T1.5.
   depends_on: `T2.3`.
5. **T2.5 — `kt_list_tracks` implemented + unit-tested.** Acceptance:
   returns a project's tracks with their stored `status`, optionally
   filtered by `status`; unit-tested per T1.5. depends_on: `T2.3`.
6. **T2.6 — `kt_get_track` implemented + unit-tested.** Acceptance:
   returns one track plus its items (ordered by `sequence_position`) and
   dependency graph; unit-tested per T1.5. depends_on: `T2.4`.
7. **T2.7 — `kt_get_project_status` implemented + unit-tested.**
   Acceptance: returns tracks, items, and open `drift_flags` for a
   project in one call; unit-tested per T1.5. depends_on: `T2.6`.
8. **T2.8 — `kt_update_item_status` implemented + unit-tested.**
   Acceptance: updates an item's `status`; rejects a transition to `done`
   with `409` while any `depends_on_item_id` is not `done`; unit-tested
   per T1.5. depends_on: `T2.4`.
9. **T2.9 — `kt_record_session_summary` stub implemented + unit-tested.**
   Acceptance: inserts a row into `events` (`summary_text`,
   `files_touched`, `items_touched`) with no drift analysis performed
   yet; unit-tested per T1.5. depends_on: `T2.4`.
10. **T2.10 — `kt_record_decision` implemented + unit-tested.**
    Acceptance: inserts a row into `decisions` and, in the same
    transaction, sets the referenced track's stored `status` to
    `pivot_pending`; unit-tested per T1.5. depends_on: `T2.3`.
11. **T2.11 — `kt_check_drift` stub implemented + unit-tested.**
    Acceptance: returns an empty result with a `"no heuristics
    configured"` note rather than querying `drift_flags` for real
    findings; unit-tested per T1.5. depends_on: `T2.4`.
12. **T2.12 — `kt_render_roadmap` implemented + unit-tested.** Acceptance:
    generates a Markdown document from current tracks/items with zero
    database writes (asserted by a negative test); unit-tested per T1.5.
    depends_on: `T2.7`.
13. **T2.13 — `kt_sync_to_github` stub implemented + unit-tested.**
    Acceptance: validates its inputs and an item's existence, returns a
    `"github adapter not configured"` result, makes no HTTP calls;
    unit-tested per T1.5. depends_on: `T2.4`.
14. **T2.14 — `kt_sync_to_linear` stub implemented + unit-tested.**
    Acceptance: validates its inputs and an item's existence, returns a
    `"linear adapter not configured"` result, makes no HTTP calls;
    unit-tested per T1.5. depends_on: `T2.4`.
15. **T2.15 — Local server boots against local Postgres, full suite
    green.** Acceptance: the server starts locally (stdio or local HTTP),
    connects only to the local Postgres instance (zero outbound network
    calls), and the full unit-test suite covering `T2.2`–`T2.14` passes.
    depends_on: `T2.2`, `T2.3`, `T2.4`, `T2.5`, `T2.6`, `T2.7`, `T2.8`,
    `T2.9`, `T2.10`, `T2.11`, `T2.12`, `T2.13`, `T2.14`.

`kt_get_next_steps` (tool 5 of 14) is deliberately **not** in this list:
it has no dedicated storage or side effects to build — it's a read query
composed entirely from tracks/items already implemented by `T2.3`–`T2.8`,
so it is built and unit-tested as part of `T2.15`'s hardening pass rather
than getting its own numbered item.

---

## T3 — Deploy + auth (Railway reference deployment)

**Status:** `blocked`.
**depends_on:** `T2`.

1. **T3.1 — Railway project + managed Postgres provisioned.**
   Acceptance: a Railway project exists with a Postgres add-on attached
   and its connection string stored as a Railway secret.
   depends_on: `T2.15`.
2. **T3.2 — Migrations applied to the Railway Postgres instance.**
   Acceptance: the same migration set from `T2.1` runs clean against the
   Railway database with no manual intervention. depends_on: `T3.1`.
3. **T3.3 — KnoTrack server running on Railway.** Acceptance: the server
   is deployed as a persistent Railway service, reachable over HTTPS at a
   stable URL, and a health-check endpoint returns 200.
   depends_on: `T3.2`.
4. **T3.4 — Bearer token auth enforced end-to-end.** Acceptance: an
   unauthenticated MCP request to any tool is rejected with 401; a
   request bearing a valid token (issued via the admin CLI against
   `api_tokens`) succeeds; both cases are unit-tested. depends_on: `T2.15`.
5. **T3.5 — Bearer auth verified from one real MCP client.** Acceptance:
   a real MCP client (e.g. Claude Desktop or Claude Code) configured with
   an issued bearer token successfully calls `kt_register_project` and
   `kt_create_track` against the Railway deployment.
   depends_on: `T3.3`, `T3.4`.
6. **T3.6 — Railway reference-deployment runbook drafted.** Acceptance:
   `docs/deploy/railway.md` documents provisioning, required env vars,
   secret rotation, and rollback steps, sufficient for someone unfamiliar
   with the project to redeploy from scratch. depends_on: `T3.5`.

---

## T4 — Second-client verification

**Status:** `blocked`.
**depends_on:** `T3`.

1. **T4.1 — Second MCP client configured against the existing server.**
   Acceptance: a second, different MCP client (e.g. Windsurf) is pointed
   at the same Railway URL and bearer token used in `T3.5`, with zero
   server-side code or config changes. depends_on: `T3.3`, `T3.4`.
2. **T4.2 — Full tool-call smoke test from the second client.**
   Acceptance: from the second client, `kt_register_project`,
   `kt_create_track`, `kt_create_item`, `kt_update_item_status`,
   `kt_get_next_steps`, `kt_check_drift`, and `kt_record_session_summary`
   all succeed against the same instance, with results matching what
   `T3.5` observed from the first client. depends_on: `T4.1`, `T3.5`.
3. **T4.3 — Client-compatibility notes documented.** Acceptance:
   `docs/client-compatibility.md` records any client-specific quirks
   observed in `T4.2` and confirms none required a server change.
   depends_on: `T4.2`.

---

## T5 — GitHub + Linear adapters

**Status:** `blocked`.
**depends_on:** `T4`.

1. **T5.1 — Credential encryption at rest implemented.** Acceptance:
   `adapters.encrypted_credential` is written using envelope encryption
   (e.g. AES-256-GCM under a server-held master key), the plaintext token
   is never persisted, and a unit test confirms the stored bytes are
   ciphertext with a correct decrypt round-trip. depends_on: `T2.15`.
2. **T5.2 — `kt_sync_to_github` fully implemented.** Acceptance: given a
   stored encrypted GitHub credential, calling `kt_sync_to_github`
   creates/updates a linked GitHub Issue for a KnoTrack item and records
   the issue URL on the item, verified against one real test repository.
   depends_on: `T2.12`, `T5.1`.
3. **T5.3 — `kt_sync_to_linear` fully implemented.** Acceptance: given a
   stored encrypted Linear credential, calling `kt_sync_to_linear`
   creates/updates a linked Linear issue for a KnoTrack item and records
   the issue URL on the item, verified against one real test Linear
   workspace. depends_on: `T2.13`, `T5.1`.
4. **T5.4 — Credential revocation path implemented + unit-tested.**
   Acceptance: deleting a stored GitHub/Linear credential causes the next
   sync call to fail with a clear "credential not configured" error
   rather than crashing or silently using a stale token.
   depends_on: `T5.2`, `T5.3`.

---

## T6 — Drift heuristics

**Status:** `blocked`.
**depends_on:** `T5`.

1. **T6.1 — Out-of-sequence detection implemented.** Acceptance: when an
   item is marked `done` while an item it `depends_on` (via
   `item_dependencies`) is not `done`, the engine writes a `drift_flags`
   row with `kind = 'out_of_sequence'`; unit tests cover both a
   true-positive and a true-negative case. depends_on: `T2.15`.
2. **T6.2 — Orphan file-change detection implemented.** Acceptance: when
   a recorded session's `files_touched` includes a path not associated
   with any open item in the project, the engine writes a `drift_flags`
   row with `kind = 'orphan_file_change'`; unit tests cover both a
   true-positive and a true-negative case. depends_on: `T2.9`, `T6.1`.
3. **T6.3 — Drift engine wired into `kt_record_session_summary`.**
   Acceptance: calling `kt_record_session_summary` now runs both
   heuristics from `T6.1`/`T6.2` against the recorded session and
   persists any resulting `drift_flags` rows.
   depends_on: `T6.1`, `T6.2`, `T2.9`.
4. **T6.4 — Drift engine wired into `kt_check_drift`.** Acceptance:
   calling `kt_check_drift` returns real open `drift_flags` rows for a
   project, replacing the `T2.11` stub's "no heuristics configured"
   response. depends_on: `T6.1`, `T6.2`, `T2.11`.
5. **T6.5 — Drift heuristics end-to-end test suite green.** Acceptance:
   a fixture-project test suite covering `T6.3` and `T6.4` passes, with
   both tools returning real (non-stub) drift data.
   depends_on: `T6.3`, `T6.4`.

---

## T7 — Public release prep

**Status:** `blocked`.
**depends_on:** `T4`, `T5`, `T6`.

1. **T7.1 — Render+Supabase deploy track verified.** Acceptance: the same
   codebase (same commit as the Railway reference) is deployed to Render
   with Supabase Postgres, the health-check passes, and one real MCP
   client successfully calls `kt_register_project` against it.
   depends_on: `T6.5`.
2. **T7.2 — Fly.io deploy track verified.** Acceptance: the same codebase
   is deployed to Fly.io, the health-check passes, and one real MCP
   client successfully calls `kt_register_project` against it.
   depends_on: `T6.5`.
3. **T7.3 — Deployment runbook finalized for all three platforms.**
   Acceptance: `docs/deploy/` contains an independently followable
   runbook per platform (Railway, Render+Supabase, Fly.io).
   depends_on: `T7.1`, `T7.2`, `T3.6`.
4. **T7.4 — Adversarial-review pipeline passes on the release commit.**
   Acceptance: the multi-model adversarial-review pipeline is run against
   the candidate release commit and returns zero CONFIRMED blocking
   findings. depends_on: `T7.1`, `T7.2`.
5. **T7.5 — License, NOTICE, and README finalized.** Acceptance:
   `LICENSE`, `NOTICE` (third-party attributions), and `README.md`
   (install, quickstart, and a reference entry for all 14 tools) are
   committed and reviewed. depends_on: `T7.4`.
6. **T7.6 — Release commit tagged.** Acceptance: a git tag (e.g.
   `v1.0.0`) is created on the commit that passed `T7.4`, with a matching
   `CHANGELOG.md` entry. depends_on: `T7.5`.

---

## T8 — Dogfood cutover

**Status:** `blocked`.
**depends_on:** `T7`.

1. **T8.1 — KnoTrack registers itself as a tracked project.**
   Acceptance: `kt_register_project` is called against the released,
   deployed KnoTrack instance with name `"KnoTrack"`, returning a
   `project_id`. depends_on: `T7.6`.
2. **T8.2 — This roadmap loaded as Tracks and Items.** Acceptance: all
   eight Tracks and every Item in this document exist in the running
   instance via `kt_create_track`/`kt_create_item` calls, with
   `depends_on` fields matching this document exactly.
   depends_on: `T8.1`.
3. **T8.3 — Historical status backfilled.** Acceptance: every completed
   Item under `T1`–`T7` is set to `done` via `kt_update_item_status`
   (there is no track-status tool by design — see the tool table above —
   so each track's stored status is instead brought to `done` the same
   way it would happen in normal operation: by its items all reaching
   `done`, seeded directly at the storage layer for this one backfill
   pass since these events predate the running instance); any real pivot
   that occurred during T1–T7 is additionally recorded via
   `kt_record_decision` so the audit trail isn't silently backdated.
   depends_on: `T8.2`.
4. **T8.4 — Session-recording cutover.** Acceptance: `CONTRIBUTING.md`
   states that all further KnoTrack development sessions are recorded via
   `kt_record_session_summary` instead of ad hoc notes, and the first
   real (non-seed) session after cutover is recorded this way.
   depends_on: `T8.3`.

---

## How this becomes the dogfood seed

Once `T7.6` is done and a bearer token exists for the release deployment,
loading this roadmap into that running instance is a straight, one-pass
walk of the document — Tracks in `T1`…`T8` order, then each Track's Items
in the order listed — because every `depends_on` above only ever points at
a Track or Item that appears earlier in that same walk.

```
project = kt_register_project(name="KnoTrack", source_type="github",
                               source_ref="<org>/knotrack")

track_id = {}   # roadmap Track id -> real track id
item_id  = {}   # roadmap Item id  -> real item id

for track in [T1, T2, T3, T4, T5, T6, T7, T8]:      # in document order
    track_id[track.id] = kt_create_track(
        project_id = project.id,
        title      = track.title,
        status     = track.status,                  # "on_track" for T1, else "blocked"
        depends_on = [track_id[d] for d in track.depends_on],
    )

    for item in track.items:                        # in document order within the track
        item_id[item.id] = kt_create_item(
            project_id = project.id,
            track_id   = track_id[track.id],
            title      = item.title,                 # e.g. "kt_register_project implemented + unit-tested"
            # acceptance criterion goes wherever the schema's free-text
            # field for it lives (e.g. embedded in `title` or a
            # `description`-style column, per the finalized TRD/DB schema)
            depends_on = [item_id[d] for d in item.depends_on],  # may reference items in earlier tracks
        )

kt_record_session_summary(
    project_id    = project.id,
    summary_text  = "Seeded KnoTrack's own roadmap (docs/ROADMAP.md) as the "
                     "initial Tracks/Items; backfilled T1-T7 status to match "
                     "reality as of the cutover date.",
    files_touched = ["docs/ROADMAP.md"],
    items_touched = [item_id["T8.2"], item_id["T8.3"]],
)
```

After this runs, `T8.4` is satisfied going forward: every subsequent
KnoTrack development session is recorded with `kt_record_session_summary`
against this same `project_id`, and `kt_check_drift` /
`kt_get_project_status` on that project are the live status of KnoTrack's
own development from that point on.

---

## Backlog: external research, borrowed vs. rejected

Reviewed two comparable tools ([automazeio/ccpm](https://github.com/automazeio/ccpm)
and the [mcpmarket.com project-management skill](https://mcpmarket.com/tools/skills/project-management-3))
partway through this build. Recorded here so the decisions aren't re-litigated later.

**Borrowed (backlog, not v1-blocking):**
- **`T9.x` (new, unscheduled) — thin CLI wrapper.** CCPM runs deterministic
  read operations (status, standup) as plain scripts with zero LLM token
  cost. `kt_get_project_status` is already a deterministic query under the
  hood; exposing the same service-layer call as a local CLI command (no
  MCP round-trip, no agent required) is a cheap, additive win for humans
  and CI. Not needed for v1; candidate for right after `T7`.
- **`T9.x` (new, unscheduled) — companion `SKILL.md`.** CCPM ships an
  "Agent Skills"-format file alongside its GitHub-Issues backbone, which
  reportedly gets picked up by Factory and Cursor in addition to Claude.
  Pairing our existing `AGENTS.md` breadcrumb with a `SKILL.md` is cheap
  and purely additive — does not replace the MCP-first strategy, just
  gives a second, lower-effort discovery path for harnesses that support
  the convention but haven't wired up our MCP server yet.
- **Backlog idea, not scheduled — per-Item long-form notes.** The
  mcpmarket skill keeps a `spec.md`/`plan.md`/`findings.md` per tracked
  issue. KnoTrack's `items` table has no equivalent free-text field today
  (only `tracks.source_doc_ref` exists, at the track level). Worth
  revisiting if real usage shows items need more context than a title —
  deliberately not added now to avoid speculative schema growth.

**Considered and rejected:**
- **CCPM's git-worktree parallel-execution model** (decomposing an issue
  into work streams, running multiple agents across isolated worktrees).
  This is dispatch — the exact orchestrator behavior KnoTrack was
  explicitly scoped to never do, from the very first design conversation.
  Adopting it would reverse that line on purpose. Rejected.
- **The mcpmarket skill's rigid six-phase workflow** (Start→Specify→Plan→
  Implement→PR→Sync) and its **"companion agents" for background
  bookkeeping.** Both push KnoTrack toward prescribing *how* work gets
  done, or running its own always-on agent loop — contradicting the
  deterministic, self-hosted, no-daemon design already settled on
  (see `ARCHITECTURE.md` §6, the anti-orchestrator argument). Rejected.

**Deferred from the v1 adversarial review (see `.adversarial-review/run-20260823-020205/report.md`
and `suppressions.json` in that run for full technical justification, reproduction notes, and
expiry dates). All items below were confirmed real by direct code reading during that review —
none are guesses — but judged disproportionate to fix reactively under review pressure:**
- **`T9.x` (new, unscheduled) — DB-operation retry/backoff.** No service
  function retries a transient DB failure (connection reset, serialization
  error) today; a failure just fails fast and rolls back cleanly (the
  transaction wrapper already guarantees no partial state — see
  `ARCHITECTURE.md` §... failure-mode notes). Real gap, but a correct
  generic retry layer needs to reason about which operations are safe to
  retry blindly, which is a bigger, cross-cutting change than fits
  reactively inside one review; tracked here instead of built ad hoc.
  Suppression expires 2026-11-23 — revisit before then. (Findings
  `reliability-2`, `reliability-5`.)
- **`T9.x` (new, unscheduled) — bound `files_touched` and adapter-secret
  input sizes.** `kt_record_session_summary`'s `files_touched` array and
  `kt_register_project`'s `adapters.*` credential strings have no `.max()`
  bound in `src/schemas/tools.ts` — an authenticated caller can submit
  arbitrarily large payloads, a storage/memory DoS vector. Needs a handful
  of Zod `.max()` additions; small but not done reactively under review.
  (Finding `security-3`.)
- **`T9.x` (new, unscheduled) — stop echoing raw exception text to
  clients.** `register-project.ts`'s error path puts the raw driver/crypto
  exception message on `details.cause`, which `runTool` serializes verbatim
  into the client-facing error envelope — a low-severity internals leak.
  Needs the same "log full detail server-side, return a generic message"
  treatment already used elsewhere. (Finding `security-4`.)
- **`T9.x` (new, unscheduled) — stop disclosing Node.js version on
  unauthenticated `/info`.** Low-severity recon surface for an attacker
  fingerprinting the server. (Finding `security-5`.)
- **`T9.x` (new, unscheduled) — close `hasOpenFlagForItem`'s TOCTOU race.**
  Same check-then-insert race family as `correctness-1` (already fixed for
  sequence-position auto-assign via `SELECT ... FOR UPDATE`), but for
  drift-flag dedup: concurrent `record_session_summary` calls can insert
  duplicate open flags for the same item. Likely closes with the same
  partial-unique-index pattern used for `correctness-1`'s fix. (Finding
  `correctness-2`.)
- **Needs a product decision, not a code fix — `findSequenceSkips`'
  "complete" definition.** The reviewer flagged (confidence 0.3, genuinely
  ambiguous against TRD text) that `findSequenceSkips` treats an item with
  status `in_progress` as "complete" for ordering purposes. Before this is
  actionable, Paul needs to say whether `in_progress` should count as
  complete for sequence-skip detection or not — this is a semantics
  question, not a bug with an obvious fix. (Finding `correctness-3`.)
- **`T9.x` (new, unscheduled) — five test-coverage gaps, no behavior
  change.** (1) `kt_record_session_summary`: no 404 test for
  `items_touched` referencing a nonexistent item id. (2) `runTool`'s error
  envelope shape and generic-error redaction has no direct unit test. (3)
  `kt_register_project`'s Linear-adapter credential encryption path is
  untested (only GitHub's is). (4) `kt_get_project_status`: no test
  verifies `drift_flags` field mapping when open flags actually exist. (5)
  No test verifies a soft-deleted project (`deleted_at` set) is rejected by
  every service function, not just some. All confirmed real gaps, all
  test-only additions. (Findings `test_quality-1` through `test_quality-5`.)
- **`T9.x` (new, unscheduled) — structured logging for drift-scan
  outcomes.** No log line records drift-scan duration, item count scanned,
  or flags raised per `kt_record_session_summary` call — an observability
  gap, not a correctness one. (Finding `reliability-6`.)

**Accepted risk, not a backlog item — the single shared-token trust model.**
Findings `security-1` and `security-3` from the *initial* panel pass (distinct
from the `security-3` above, which is from the final rerun and reused the same
id) argued that any valid bearer token can read/write any project on the
instance, including rotating another project's adapter credentials via
`kt_register_project`'s upsert. `docs/TRD.md` §4/§7 document this as the
deliberate v1 trust boundary — one instance, one operator, one trust domain;
isolating two teams means running two instances — not an omission. Suppression
expires 2027-02-23. Revisit only if a genuine multi-tenant (multiple mutually
untrusting operators on one instance) need shows up; until then, nothing to
build.

**Deferred from PR #1's CodeRabbit review round (2026-08-23/24) — architecture/
scope decisions, not bugs, per the `clear-decisions` walkthrough:**
- **`T9.x` (new, unscheduled) — a path to unblock a `blocked` track.**
  `kt_create_track` can set a track to `blocked` when a declared dependency
  isn't `done`, but there is no write path from `blocked` back to
  `on_track` or `done` once created — dependents stay blocked permanently.
  Deferred until a real caller actually hits this (no current tool
  triggers the transition back).
- **`T9.x` (new, unscheduled) — `@modelcontextprotocol/sdk` v1 → v2
  migration.** Needed for `server/discover` and the 2026-07-28 protocol
  revision's stateless discovery mechanism. Breaking (modular v2 packages,
  ESM-first, Zod `^4.2.0` requirement), touches every tool registration and
  the core transport. Deferred indefinitely — no current forcing need.
- **`T9.x` (new, unscheduled) — migration rollback (`down`) mode.**
  `scripts/migrate.ts` only applies migrations forward; there's no guarded
  mode to run `.down.sql` files in reverse and remove their ledger entries.
  Note this isn't just a TRD gap: `T2.1` above states `migrate down`
  cleanly reverses `001_init.sql` as its own acceptance criterion, so this
  was always intended, not merely documented aspirationally. Deferred
  until a real forward migration actually needs reverting.
- **`T9.x` (new, unscheduled) — finish propagating the source_type/
  source_ref registration model through the remaining docs.** Commits
  `5809ae4`/`bca45ff` fixed the "13 tools"/ID-format/cross-track-deps/
  credential-contract drift in `PRD.md` sections 4.1, 4.4, 4.7, 5.3, and
  the Appendix, but did not touch: `kt_get_project_status`'s own PRD
  section (still describes a `{ project: { root_path, repo_url,
  adapters_enabled } }` shape that `get-project-status.ts` doesn't return
  at all — flagged as its own separate drift in commit `208c90b`, not
  re-verified this round); `kt_render_roadmap`, `kt_sync_to_github`, and
  `kt_sync_to_linear`'s PRD sections (all three are unimplemented v1 stubs
  — `src/mcp/tools/stubs.ts` — so there's no real code yet to verify the
  `root_path`/`repo_url`/`adapters_enabled`/`GITHUB_TOKEN`/`LINEAR_API_KEY`
  prose against); and one stray `root_path`/`repo_url` mention in PRD.md
  §6's glossary. Needs a pass once `kt_get_project_status` is re-verified
  against real code and/or the sync tools get real implementations —
  documenting the sync tools' contract now would be speculative ahead of
  building them.
