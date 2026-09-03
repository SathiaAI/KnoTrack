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

## Keeping this doc honest (added 2026-08-28)

This file is hand-maintained Markdown, and its `Status:` lines had drifted
from reality more than once before anyone noticed — T2 and T3 both sat at
a stale `blocked` header long after real work under them had shipped and
been deployed and verified. Found each time by someone actually tracing
code against prose, never by the doc flagging itself. Until `T8` lands
(this doc's own second job — see above), this is the standing rule for
keeping it from happening again:

1. **A PR that completes an Item's stated acceptance criterion updates
   that Item's Track `Status:` line in the same PR**, not as a follow-up.
   If the PR only partially satisfies a Track (some Items done, others
   not), say so explicitly in the `Status:` line rather than leaving the
   old blanket status in place — "on_track, substantially complete but
   not done" (as this pass just wrote for `T2`) beats a stale `blocked`
   every time.
2. **Don't trust an existing `Status:` line when starting new work that
   depends on it.** Check the actual code the way this pass did for
   `T1`'s `T1.6` gate (found not actually satisfied — `docs/SIGNOFF.md`
   doesn't exist — despite `T2`/`T3` having been built on top of it
   anyway) before treating a stated dependency as real.
3. **The real fix is `T8`, not more discipline.** A hand-maintained
   status doc will keep drifting no matter how careful anyone is about
   rule 1 — that's the exact problem KnoTrack itself exists to solve for
   its users, and there's no reason its own project should be the
   exception. Once `T2.16` (track/item completion) and a working
   `kt_check_drift` (`T6`) exist, `kt_get_project_status` against
   KnoTrack's own dogfooded instance becomes the live, self-correcting
   version of this section — worth doing even informally, ahead of the
   full `T8` cutover, once the pieces it needs exist.

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

**Status:** `on_track`, functionally superseded by later work but **not
formally closed** (corrected 2026-08-28 — this is not a clean flip to
`done`; checked directly rather than assumed). `T1.1`–`T1.5` are
satisfied: PRD, TRD, Architecture doc, DB schema, and the test-case
matrix are all committed. `T1.6` ("cross-document consistency pass...
zero open discrepancies... sign-off recorded in `docs/SIGNOFF.md`") is
**not met on its own stated terms**: `docs/SIGNOFF.md` does not exist in
this repo, and the "zero open discrepancies" bar was never actually hit
— the "Documentation-completeness audit" and "PR #1 CodeRabbit deferrals"
entries in this doc's backlog section (below) record discrepancies found
*after* T1 work proceeded, several of which (the `kt_get_project_status`/
`kt_render_roadmap`/sync-tool PRD sections) are still open today. T2/T3
were built on top of T1 anyway because the individual specs were solid
enough to implement against, not because `T1.6`'s gate was actually
passed. Leaving this honestly as `on_track` rather than backdating a
`done` that never happened — the seed-state note ("the only Track not
`blocked` initially") is preserved below for historical context.
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

**Status:** `on_track`, substantially complete but **not `done`**
(corrected 2026-08-28, replacing a stale blanket `blocked` that hadn't
been touched since this doc's initial draft). Per the "Status
reconciliation" note below (already in this doc, now current as of PR
#9): 11 of 14 tools are fully implemented and unit-tested
(`T2.2`–`T2.10`, `T2.12`); the remaining 3 (`T2.11` `kt_check_drift`,
`T2.13` `kt_sync_to_github`, `T2.14` `kt_sync_to_linear`) are correctly
out of T2's real scope — full behavior is T5/T6 work — but even their
*stub* acceptance criteria aren't fully met yet: all three currently
return a generic `500 INTERNAL_ERROR` (`notImplementedResult` in
`src/mcp/tool-helpers.ts`) rather than each one's specific
bespoke-message contract (`T2.11` wants an empty result + "no heuristics
configured"; `T2.13`/`T2.14` want "adapter not configured" after
validating the item exists). That's a small, cheap, currently-untracked
gap against T2's own stated acceptance criteria — worth a follow-up item
rather than leaving implicit in a reconciliation note.

<!-- STUB_TOOLS: kt_check_drift, kt_sync_to_github, kt_sync_to_linear -->
**The line above is machine-checked, not decorative.** `npm run
check-roadmap-drift` (wired into CI, `.github/workflows/ci.yml`) parses
`src/mcp/tools/stubs.ts`'s actual `STUBS` array and fails the build if it
doesn't match this exact list. This is the direct, deterministic answer
to "how do we stop the roadmap silently going stale again" — added
2026-08-29 after this doc's Track status headers were found drifted for
the second time. When a stub tool ships for real, update the marker line
above in the same PR that removes it from `stubs.ts`, or CI blocks the
merge. Don't hand-edit this line without also verifying it against
`stubs.ts` — that defeats the point.
**depends_on:** `T1` (in practice, T2's implementation proceeded despite
`T1.6` not being formally closed — see T1's status note above; recorded
here rather than silently treating the dependency as satisfied).

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

16. **T2.16 — Track lifecycle: switch `on_track`/`blocked`/`done` from
    stored to derived (revised 2026-08-29 — supersedes this item's own
    first draft from the day before; design decided and approved by
    Paul 2026-08-29, not yet built — see the "Decided by Paul" note
    below).** Closes a real gap found by tracing `tracks.status`
    end to end, not merely inferred: the schema and `kt_create_track`'s
    own blocking check (`allDependenciesDone = ... === 'done'`) both
    treat `done` as a reachable track status, but per `docs/TRD.md` §3.5
    exactly two things ever write `tracks.status` — `kt_create_track`
    (initial `on_track`/`blocked`) and `kt_record_decision` (→
    `pivot_pending`) — and **neither ever sets `done`**. No track can
    reach `done` in normal operation today, which means no `blocked`
    track's dependency can ever resolve either.

    **Revision note:** this item's first draft (written 2026-08-28)
    proposed patching the write side — have `kt_update_item_status`
    recompute and cascade-update the stored `tracks.status` column in
    the same transaction. That works, but it has the same failure shape
    as the bug it's fixing: it depends on every future code path that
    touches item or dependency state remembering to run the
    recomputation, forever. Given this whole exercise started because a
    hand-maintained status field silently went stale, shipping a second
    hand-maintained status field (just automated instead of manual) is
    not the strongest fix available. A harder look at the alternative:

    **Revised mechanism — compute `on_track`/`blocked`/`done` at read
    time instead of storing them:**
    a. Drop the write side entirely for these three values. Every
       consumer of `tracks.status` — not just `kt_list_tracks`,
       `kt_get_track`, and `kt_get_project_status` (`T2.5`/`T2.6`/`T2.7`)
       but also `kt_create_track` (validates `depends_on` tracks are
       `done` before allowing an `on_track` child, via
       `getTrackStatusesForProject`) and `kt_get_next_steps`/
       `kt_render_roadmap` (via `getTrackSummariesForProject`) —
       switches to computing each track's effective status via a query
       (a CTE or equivalent) over its items' `status` and its
       `track_dependencies` edges (adversarial PR review finding: an
       earlier draft of this item named only the three read tools,
       leaving these other three call sites still reading the
       soon-to-be-stale stored column). The computation itself:
       `done` iff the track has at least one item, every one of its
       items is `done`, **and** every `depends_on` track is itself
       effectively `done` (adversarial PR review finding, two distinct
       gaps in the original draft: (1) it let a track compute `done`
       from its own items alone even while a dependency it structurally
       requires was still open, which the `blocked` case below already
       treated as disqualifying — the two cases were inconsistent with
       each other; (2) a freshly created track with zero items
       satisfied "every item is `done`" vacuously and would read as
       `done` before any real work existed); `blocked` iff not `done`
       and (the track has zero items, or at least one item is not
       `done`, or at least one `depends_on` track is not effectively
       `done`); `on_track` otherwise. There is no cascade to write,
       because nothing is ever wrong-until-updated — every read is
       correct by construction, the same way `kt_get_next_steps` is
       already a pure read over live data rather than a cached table.
    b. `pivot_pending` is the one genuinely stateful fact here — it's an
       explicit human/agent decision, not a function of item state — so
       it stays a **stored** override on `tracks` (a `pivot_pending
       boolean` or equivalent), checked first: a track with the flag set
       shows as `pivot_pending` regardless of what (a) would otherwise
       compute, and `kt_record_decision` remains its only writer.
    c. This also **removes open question 2 from the first draft**
       entirely rather than just deferring it: "does a track un-complete
       if an item regresses" was only a hard question under the stored
       model, where reverting requires deliberately re-triggering a
       cascade. Under a derived model there's nothing to revert — the
       next read simply reflects current reality, the same way it always
       does. One fewer open decision, not because it was punted, but
       because the better architecture makes the question not apply.
    d. Trade-off, stated plainly rather than assumed away: `docs/TRD.md`
       §3.5's original reason for making `tracks.status` a stored column
       was so `kt_list_tracks`'s status filter could be "a direct `WHERE
       tracks.status = ...` clause... no post-processing step needed."
       A derived column can't use a plain index lookup the same way —
       it costs a join/aggregate per read instead. At the PRD's own
       stated v1 ceiling (200 tracks, 100 items/track per project, §6.3)
       this is very unlikely to be measurable, but it hasn't been
       benchmarked, and "very unlikely" is a claim to verify against the
       `<200ms` simple-read budget (TRD §6.1) before treating it as
       settled, not to assume.

    **Decided by Paul (2026-08-29):** a `pivot_pending` track never
    auto-resolves — it always requires an explicit action, the same way
    entering the pivot required one. That means this item's scope grows
    by one small, symmetric piece: `kt_record_decision` gains an
    optional `resolves_pivot: true` input, which — in the same
    transaction as recording the (already-required) rationale/
    what-changed text — clears the pivot override instead of setting it.
    No new tool; this stays inside the existing 14, matching how
    `kt_record_decision` already both opens a pivot and now closes one,
    each time leaving an audit-trail entry explaining why. Once cleared,
    the track's status is whatever (a)–(c) above compute from its actual
    item/dependency state, same as any other track.

    Acceptance: a benchmark confirming the derived-status query stays
    inside the `<200ms` simple-read budget at the PRD's stated v1 scale;
    unit tests for a track computing `done` the instant its last item
    does, a track with zero items never reading as `done` regardless of
    its dependencies, a track whose own items are all `done` still
    reading as `blocked` while a `depends_on` track is not effectively
    `done`, a chain of dependent tracks computing `on_track` in the same
    read with no separate propagation step, a track regressing correctly
    with no stale cached value anywhere, a `pivot_pending` track
    confirmed staying `pivot_pending` through item completion until
    `kt_record_decision(resolves_pivot: true)` is called, and that call
    both clearing the override and appearing in the Decision audit log;
    `docs/TRD.md` §3.5 and §3.10 rewritten to describe the derived model
    and `kt_record_decision`'s new input. depends_on: `T2.5`/`T2.6`/
    `T2.7` (the three read tools whose queries change), `T2.3`
    (`kt_create_track`'s dependency-completeness check reads the same
    derived status), `T2.12` (`kt_render_roadmap`, and `kt_get_next_steps`
    alongside it per its `T2.15` note above, both read track status via
    `getTrackSummariesForProject`), `T2.10` (`kt_record_decision`,
    already shipped, gains the new field).

**Status reconciliation (added retroactively — this Track's items above
describe the plan, not yet what shipped at the time this note was
written).** **Update (T2 build-out, PR #7, #8, and #9):** this note
originally said only 5 of 14 tools were fully implemented and listed
`kt_list_tracks`, `kt_get_track`, `kt_get_next_steps`, and
`kt_render_roadmap` among the unimplemented ones — all four have since
shipped (PR #7: `kt_list_tracks`/`kt_get_track`; PR #8:
`kt_get_next_steps`/`kt_render_roadmap`), and this branch (PR #9) itself
implements the remaining two, `kt_update_item_status` and
`kt_record_decision`. As of this branch, 11 of 14 tools have the full
implementation this Track calls for: the original 5
(`kt_register_project` `T2.2`, `kt_create_track` `T2.3`, `kt_create_item`
`T2.4`, `kt_get_project_status` `T2.7`, `kt_record_session_summary`
`T2.9`) plus `kt_list_tracks` (`T2.5`), `kt_get_track` (`T2.6`),
`kt_get_next_steps`, `kt_render_roadmap` (`T2.12`),
`kt_update_item_status` (`T2.8`), and `kt_record_decision` (`T2.10`).
The remaining 3 are registered as stubs (`src/mcp/tools/stubs.ts`:
correct request/response shape, no real logic, no external calls) and
are all out of T2 scope entirely — `kt_check_drift` (`T2.11`/`T6`) and
the two sync tools (`T2.13`, `T2.14`) (T5/T6). The rest of this note
below is preserved as originally written (a point-in-time record of what
the gap looked like when first written down), except where a later
edit is explicitly marked:
- **`T2.8` (`kt_update_item_status`) and `T2.10` (`kt_record_decision`)
  were stubs as of PR #7/#8 and are now fully implemented on this branch
  (PR #9)** — the paragraph below describing them as stubs reflects that
  earlier point in time, not this branch's current state; kept here
  unedited as the point-in-time record the "Update" note above exists to
  contextualize. This was the gap behind the "old model path" flag and
  the PR #1 CodeRabbit deferrals recorded in this doc's backlog section —
  it was never previously written down in one place that these tools
  were behind this Track's own stated scope, not merely "not yet built"
  in the abstract.
- **`T2.9` (`kt_record_session_summary`)** exceeds its own acceptance
  criterion, but not by fully doing `T6.1`'s job. The `T2.9` criterion
  asks only for an `events` insert "with no drift analysis performed
  yet"; the shipped version already runs a real scoped check
  (`findSequenceSkips`, wired in via `adversarial-review` fixes) and
  writes/resolves `drift_flags` rows for it, targeting the DB's
  `kind='out_of_sequence'` — the same thing TRD Appendix C calls
  `SEQUENCE_SKIP` (positional: an earlier item in the same track still
  `pending`/`blocked` while a later one is `done`). That is **not** what
  `T6.1`'s acceptance criterion literally asks for ("an item marked
  `done` while an item it `depends_on` via `item_dependencies` is not
  `done`" — a dependency-graph check, closer to TRD's `DEPENDENCY_GAP`,
  which is a different rule already enforced synchronously by
  `kt_update_item_status`'s 409 check, not by this drift check).
  `T6.1`'s own title ("out-of-sequence detection") and its
  `kind='out_of_sequence'` target don't actually match its
  acceptance-criterion wording either — a separate, small inconsistency
  in `T6.1` itself, worth fixing when `T6` is actually built rather than
  papered over here. `T6.2` (orphan-file-change) isn't implemented at
  all, so `T6.3`'s "both heuristics" criterion is unmet regardless of
  how `T6.1` gets reconciled. `T2.11` (`kt_check_drift`) and the two
  sync stubs (`T2.13`, `T2.14`) do **not** actually match their
  stub-only acceptance criteria either, on closer check:
  `registerStubTools` routes every remaining stub tool through the
  same generic `notImplementedResult` (`src/mcp/tool-helpers.ts`), which
  always returns a uniform `500 INTERNAL_ERROR` — not `T2.11`'s specific
  "empty result with a `no heuristics configured` note", and not
  `T2.13`/`T2.14`'s specific "adapter not configured" result after
  validating the item exists. The generic-500 stub shape is the same for
  every unimplemented tool (3 as of this branch — see the "Update" note
  above; originally 9 when this paragraph was first written); none of the
  three has the bespoke stub-response behavior its own T2 line calls for.
- Nothing in `T1.6`'s "cross-document consistency... zero open
  discrepancies" gate accounted for this Track-vs-build gap either — it
  checks the docs against each other, not the docs against what actually
  got built. Worth knowing before treating "T1 done, T2 blocked" as
  literal build status.

---

## T3 — Deploy + auth (Railway reference deployment)

**Status update, 2026-09-03: `T3.1`–`T3.4`, `T3.7`, `T3.8` all `done`,
verified by a real fresh redeploy's logs (see the T3.7/T3.8 items below).
`T3.6` (this runbook) also `done`. Only `T3.5` remains — needs a real MCP
client under Paul's control, not something this session can complete on its
own.** Everything below this line is the historical root-cause investigation
and fix that got T3 to this point — preserved for the record, not still the
live status.

**Status (historical, 2026-08-29):** `on_track`, not yet `done` — **regression found AND root-caused
2026-08-29; live data path restored, but the automated path (`T3.2`) is
still broken and only worked around.** The 2026-08-28 status line
claimed `T3.1`–`T3.5` "complete and verified live." That was false:
`kt_register_project` against the live Railway deployment failed with
`relation "projects" does not exist` (Postgres `42P01`) — the live
database had zero tables, not even `schema_migrations`. Most likely the
2026-08-28 pass checked `/health` (connectivity only, never schema
state) and a successful `initialize` handshake (auth only) and treated
that as "verified" without a real write-path tool call. `T3.5`'s
acceptance criterion below is tightened accordingly so this can't
recur silently.

**Root cause, found by direct reproduction, not guesswork:** the
Railway service's `deploy.startCommand` (per `get-service-config`) is
`node dist/scripts/migrate.js && node dist/src/index.js`, and
`index.js` clearly starts successfully every time — implying
`migrate.js` always exits `0` — yet Railway's deploy logs never once
showed a single line of `migrate.js`'s own console output (no
`applying: ...`, no `no pending migrations`, no `migration failed:
...`) across three separate deployments. To settle whether the bug was
in KnoTrack's code or in Railway's environment, the exact compiled
`dist/scripts/migrate.js` (byte-for-byte, same Node 20.20 version as
the production image) was run directly against the live database —
reached via a temporary Railway TCP proxy on the Postgres service,
removed immediately after — and it **worked perfectly**: connected,
applied all 5 pending migrations in order, exited 0, with full log
output. That proved the migration code itself is correct, but left the
platform-level "why doesn't it even run" question open.

**Second half of the mystery — now also resolved, 2026-08-29.** Per
Paul's request, the open question (why the platform silently never
invokes `migrate.js` at all despite `deploy.startCommand` reporting the
full chain) was put to four independent frontier models on OpenRouter,
each reasoning separately with no visibility into the others' answers:
`openai/gpt-5.1`, `google/gemini-3.5-flash`, `x-ai/grok-4.3`, and
`deepseek/deepseek-v3.2` — deliberately excluding any Anthropic-family
model as a reviewer, since the same author (this session) had already
formed a leading theory and wanted independent, differently-trained
eyes on it, not a rubber stamp. All four independently ranked the same
top hypothesis: that the running container's actual entrypoint was
fixed at build time and is not what `deploy.startCommand` currently
reports, with a `redeploy` of a stale build snapshot as the most likely
mechanism. None of the four treated the repo's leftover Dockerfile as
safely inert, despite being told Railway's own API reports
`build.builder: "RAILPACK"` — several flagged it as worth checking
directly rather than trusting that label.

That skepticism was correct, and following it up in Railway's own
**build** logs (not deploy logs, which is why this was missed before)
found the actual mechanism directly, not by inference: the build log
for every one of this service's three deployments reads `[internal]
load build definition from Dockerfile`, followed by build steps that
match the repo's `Dockerfile` line-for-line and stage-for-stage (`FROM
node:20.20-slim AS build` → `[build 1/8]` through `RUN npm run build` →
`[build 8/8]`, then the `runtime` stage through `COPY migrations
./dist/migrations` → `[runtime 6/6]`). Railway built this deployment
directly from the repo's own checked-in `Dockerfile` — not via Railpack
auto-detection at all — regardless of what `build.builder` reports via
the API. That Dockerfile's own `CMD ["node", "dist/src/index.js"]`
(deliberately written that way — its own comment says migrations "are
run as a separate deploy-time step ... never automatically on
container start") became the container's real entrypoint, and
Railway's `deploy.startCommand` override never took effect on top of
it. That fully explains every observed symptom: zero `migrate.js`
output ever, an untouched schema, and `index.js` starting cleanly in
~400ms every time (plain server boot, no migration round-trip). The
mystery is closed — not "worked around," actually understood.

**Fix decided 2026-08-29, via an independent multi-model council debate
(Paul rejected the two options first proposed — editing the Dockerfile's
own `CMD`, or deleting the Dockerfile so Railpack takes over — and asked
for a genuinely better answer rather than a pick between them; full
debate and reasoning in the Linear decision log §11 and
`docs/LESSONS_LEARNED.md`'s 2026-08-29 entry):** use Railway's
**Pre-Deploy Command** (`deploy.preDeployCommand`) — a distinct
deploy-stage mechanism, separate from both the build path and
`deploy.startCommand`, that runs after build/before app start "even when
the build is skipped," and blocks the deploy outright (no retry) on
failure. `deploy.preDeployCommand` is set to
`["node dist/scripts/migrate.js"]`; `deploy.startCommand` is reset to a
plain `node dist/src/index.js`. **The Dockerfile itself is deliberately
left untouched** — the Pre-Deploy Command approach fulfills what the
Dockerfile's own code comment already said the intent was (migrations as
a separate deploy-time step), rather than fighting it by editing or
removing it. Applied and verified live in Railway's stored config
2026-08-29; not yet exercised by an actual redeploy (see `T3.7` below).

**Update 2026-09-03: T3.2 is now done — the automated path has been proven, not
assumed.** PR #12 and PR #13 (T3.7/T3.8) merged into `main` (`035888b1`, then
`1b678490`), and Railway's GitHub auto-deploy fired immediately on each merge —
no manual redeploy trigger was needed or used. The PR #13 merge's own deployment
(`f9e9ada5-b145-4360-9c23-5ec2d70ced90`, commit `1b678490`, 2026-09-03T03:03Z)
is a **fresh, automated redeploy**, and its deploy logs show exactly the
evidence this item requires: a distinct pre-deploy container ran first
(`Starting Container` → `skip (already applied): 001_init.sql` ... `005_tracks_sync_timestamps.sql`
→ `no pending migrations — schema already up to date` → `Stopping Container`),
*then* the real app container started (`Server listening at http://...:8080`)
and the healthcheck passed. This is `migrate.js`'s own console output, from
the automated Pre-Deploy Command path, on a real redeploy — not the earlier
manual out-of-band fix, and not inferred from `/health` alone. `GET /health`
was independently re-checked live immediately after (`{"status":"ok",...,"db":"ok"}`,
`200`). **T3.2 done.**

**What this means for T3.2 specifically: it is not done.** Its own
acceptance criterion is "runs clean against the Railway database with
no manual intervention" — and manual intervention (the TCP-proxy
workaround above) is exactly how the schema actually got created this
time. The automated on-deploy migration path is unverified at best and
silently broken at worst. Marking `T3.2` done would repeat the exact
mistake this section exists to correct.

Re-checked item by item, 2026-08-29:
- `T3.1` — true. Confirmed via `mcp__Railway__get-service-config`:
  Postgres provisioned with a persistent volume
  (`/var/lib/postgresql/data`) and `KNOTRACK_DB_SSL_CA_BASE64` set.
- `T3.2` — **true as of 2026-09-03.** A fresh, automated redeploy
  (deployment `f9e9ada5`, commit `1b678490`, triggered by Railway's own
  GitHub auto-deploy on the PR #13 merge, not a manual trigger) logged
  `migrate.js`'s own console output in the pre-deploy stage
  (`skip (already applied): ...` for all 5 migrations, then
  `no pending migrations — schema already up to date`) before the app
  container started — see `T3.7` below for the full evidence. This is
  the automated path, not the earlier manual out-of-band fix.
  **Correction (adversarial PR review):** this bullet previously offered
  a second, equivalent-sounding closing condition — "or until `index.js`
  is changed to fail loudly ... — see the new `T3.7` below" — but that
  described `T3.8`, not `T3.7` (fixed above), and more importantly the
  two are not equivalent evidence for `T3.2`: `T3.8`'s guard only proves
  *some* schema is present before the server accepts traffic, which is
  already true today because of the manual out-of-band fix — a server
  that has always passed that check proves nothing about whether the
  automated migration path itself works. `T3.8` is a safety net against
  ever silently serving traffic on a stale schema again; only `T3.7`'s
  evidence closes `T3.2`.
- `T3.3` — true. `/health` returns `200` live.
- `T3.4` — true: an unauthenticated `POST /mcp` returns `401` live; an
  authenticated `initialize` call succeeds. Re-confirmed via direct
  `curl`.
- `T3.5` — **still not genuinely verified — corrected 2026-08-29**
  (this line previously said "true, genuinely verified"; that was
  wrong by this item's own acceptance criterion, caught during
  adversarial PR review). Direct `curl` calls through the real
  bearer-token path did return real success payloads —
  `kt_register_project` → `{"project_id":"c38068d5-95e7-4a69-8480-8c58d8d2f253"}`,
  `kt_create_track` → `{"track_id":"82ceffed-3e90-4f5a-8165-3ce8f20cf0f1"}`
  — real evidence that the HTTP/auth/schema path works end to end, and
  not nothing. But `T3.5`'s acceptance criterion explicitly requires
  **a real MCP client**, not raw HTTP calls, and this section's own
  root-cause writeup above already warns against exactly this shape of
  self-graded pass (treating connectivity/auth checks as equivalent to
  a real write-path client call). Remains open until an actual
  MCP-speaking client (e.g. Claude Desktop or another configured
  client) makes these calls.
- `T3.6` — **done as of 2026-09-03**: `docs/deploy/railway.md` written,
  covering provisioning, required env vars, secret rotation (including
  an honest statement of what is *not* yet safely rotatable — see the
  doc's own Secret Rotation section), and rollback.

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
5. **T3.5 — Bearer auth AND schema verified from one real MCP client.**
   Acceptance (tightened 2026-08-29 after the regression above): a real
   MCP client configured with an issued bearer token successfully calls
   `kt_register_project` and `kt_create_track` against the Railway
   deployment **and receives the tool's real success payload, not just a
   200 wrapper** — a generic `isError: true` response does not satisfy
   this criterion, since that shape is exactly what a missing-schema
   failure returns. `/health` returning `200` and a successful MCP
   `initialize` handshake do not by themselves satisfy this item either
   — both were true in production while `kt_register_project` was
   failing. depends_on: `T3.3`, `T3.4`.
6. **T3.6 — Railway reference-deployment runbook drafted.** Acceptance:
   `docs/deploy/railway.md` documents provisioning, required env vars,
   secret rotation, and rollback steps, sufficient for someone unfamiliar
   with the project to redeploy from scratch. depends_on: `T3.5`.
7. **T3.7 — New, added 2026-08-29: prove (not just re-trigger) the
   automated migration-on-deploy path.** Acceptance: a fresh
   `knotrack-server` redeploy's own Railway deploy logs show
   `migrate.js`'s own console output (`applying: ...` or `no pending
   migrations — schema already up to date`) — not merely that the
   server came up and `/health` returns 200. **Root cause identified
   2026-08-29 (see T3's status above): Railway is building this service
   from the repo's own `Dockerfile`, not via Railpack, so
   `deploy.startCommand` is never actually applied — the Dockerfile's
   own `CMD` is the real entrypoint and it deliberately excludes the
   migration step.** Still not marked done: identifying the cause isn't
   the same as observing the fix work.
   **Fix decided and applied 2026-08-29 (see T3's status above and
   `docs/LESSONS_LEARNED.md`): Railway's Pre-Deploy Command now runs
   `node dist/scripts/migrate.js` as a distinct deploy-stage step,
   `deploy.startCommand` reset to a plain server start, Dockerfile left
   untouched.** Config change applied via the Railway API and verified
   live in the stored config — not a guess this time.

   **Closed 2026-09-03.** Railway's GitHub auto-deploy fired on its own
   when Paul merged PR #12 then PR #13 — no manual redeploy trigger was
   needed. The PR #13 merge's deployment (`f9e9ada5-b145-4360-9c23-5ec2d70ced90`,
   commit `1b678490`, `2026-09-03T03:03:31Z`–`03:03:57Z`) is a genuinely
   fresh redeploy, and its own deploy logs show, in order: `Starting
   Container` (the pre-deploy container) → `skip (already applied):
   001_init.sql` through `005_tracks_sync_timestamps.sql` → `no pending
   migrations — schema already up to date` → `Stopping Container` (the
   pre-deploy container exiting cleanly) → `Server listening at
   http://...:8080` (the real app container) → healthcheck succeeded.
   This is exactly this item's required evidence — `migrate.js`'s own
   console output in a distinct pre-deploy stage on a fresh, automated
   redeploy — not merely a healthy `/health`. Independently re-confirmed
   live via `curl https://knotrack-server-production.up.railway.app/health`
   → `200 {"status":"ok",...,"db":"ok"}`. Full log evidence and mechanism
   are also written up in `docs/deploy/railway.md` (T3.6, this same date).
   depends_on: `T3.5`.
8. **T3.8 — New, added 2026-08-29: fail loudly, not silently, on a
   missing schema.** Acceptance: `src/index.ts`'s startup path checks
   for the presence of the expected schema (e.g. querying
   `schema_migrations` for the full expected set, or attempting a
   trivial `SELECT 1 FROM projects LIMIT 0`) before accepting traffic,
   and refuses to start (non-zero exit, clear log message) rather than
   serving a broken server that returns a generic `INTERNAL_ERROR` on
   every real tool call. This is the actual fix for the failure mode
   this section documents: whatever caused `migrate.js` to run with no
   observable effect, a server should never come up healthy while
   unable to do its actual job. depends_on: `T3.2`.
   **Implemented 2026-08-29, not yet verified live.** A new read-only
   `getPendingMigrationFiles` (`src/db/migration-status.ts`) diffs
   `migrations/*.sql` against `schema_migrations` (treating a missing
   `schema_migrations` table as "everything pending," not an error) and
   is wired into `src/index.ts` right after `buildFastify` and before
   `app.listen(...)`: any pending file logs one `fatal`-level message
   naming exactly which file(s) are pending and the process exits 1,
   instead of starting and accepting traffic. Covered by a unit test
   (`tests/unit/migration-status.test.ts`, all-applied /
   table-missing / partially-applied cases) and confirmed by inspection
   that `path.resolve(__dirname, '..', 'migrations')` from the compiled
   `dist/src/index.js` resolves to `dist/migrations` — matching the
   Dockerfile's `COPY migrations ./dist/migrations` layout.

   **Closed 2026-09-03 — the "stays silent" branch, specifically.** The
   same fresh redeploy that closed `T3.7` (`f9e9ada5`, commit `1b678490`)
   is real evidence for this item too: the schema was genuinely up to
   date (all 5 migrations already applied), the boot-time guard ran as
   part of `src/index.ts`'s startup path against the real Railway
   Postgres instance, logged no `fatal` refusal message, and the server
   went on to accept traffic (`Server listening...`, healthcheck 200).
   That is exactly this item's "or confirms it stays silent" acceptance
   branch, observed live — not just locally against a scratch `dist/`
   tree and a fake DB client. **The other branch (the guard actually
   refusing to start on a genuinely stale schema) has still never been
   exercised against a real Railway deploy** — only the unit tests cover
   that path directly. Noted here rather than silently treated as
   equivalent: this item's acceptance criterion offers either branch as
   sufficient, and the silent-pass branch is what actually happened, so
   the item is closed on that basis, not on the untested refusal branch.

---

## T4 — Second-client verification

**Status:** `blocked` (accurate — not started; confirmed 2026-08-28, not
assumed).
**depends_on:** `T3` (in practice `T3.5` specifically as of 2026-09-03 —
`T3.6` is now done, see T3's status above; `T3.5` remains open and is the
only thing still blocking `T4`).

1. **T4.1 — Second MCP client configured against the existing server.**
   Acceptance: a second, different MCP client (e.g. Windsurf) is pointed
   at the same Railway URL and bearer token used in `T3.5`, with zero
   server-side code or config changes. depends_on: `T3.3`, `T3.4`.
2. **T4.2 — Full tool-call smoke test from the second client.**
   Acceptance: from the second client, `kt_register_project`,
   `kt_create_track`, `kt_create_item`, `kt_update_item_status`,
   `kt_get_next_steps`, and `kt_record_session_summary` all succeed
   against the same instance, with results matching what `T3.5` observed
   from the first client; `kt_check_drift` returns its documented
   not-implemented response consistently across both clients.
   depends_on: `T4.1`, `T3.5`.
   **Correction (2026-08-28), resolved (adversarial PR review, flagged as
   an unresolved decision until now):** `kt_check_drift` is a stub today
   (`T6`, not yet built) and currently returns a `500` "not implemented"
   result for every caller, not a real drift answer — and `T6` itself
   depends on `T5`, which depends on `T4`, so deferring this criterion's
   real assertion to after `T6` ships would make `T4.2` unable to close
   until two Tracks scheduled after it are done. The acceptance above
   now takes the other, immediately verifiable option this note
   originally offered: `kt_check_drift`'s stub response, not a real
   drift answer, is what both clients are checked against. The real
   drift-answer assertion belongs to `T6`'s own acceptance criteria
   instead, once that tool exists.
3. **T4.3 — Client-compatibility notes documented.** Acceptance:
   `docs/client-compatibility.md` records any client-specific quirks
   observed in `T4.2` and confirms none required a server change.
   depends_on: `T4.2`.
4. **T4.4 — OAuth-shaped connector clients checked (Grok, Perplexity)
   (added 2026-08-28).** Not part of `T4`'s original minimum bar
   (`T4.1` only required one second client), but scheduled here rather
   than left floating: Paul has access to both and offered to run this
   himself. Unlike `T4.1`/`T4.2`'s clients, Grok and Perplexity's
   custom-connector UIs are documented as OAuth/API-Key-shaped, not a
   raw-header config file — genuinely unverified whether either can
   reach a static-bearer-token server at all (see
   `docs/deploy/client-verification-runbook.md` for the exact steps and
   what "pass" means for each). Acceptance: for each of Grok and
   Perplexity, either (a) `kt_register_project` succeeds through it and
   the result is added to `docs/client-compatibility.md`, or (b) it
   cannot be made to work with a static bearer token, and that's
   recorded as a known limitation rather than left silently untried.
   Either outcome closes the item — this is about getting a real
   answer, not requiring success. depends_on: `T3.5`.

---

## T5 — GitHub + Linear adapters

**Status:** `blocked`.
**depends_on:** `T4`, `T2.16` (added 2026-08-29 — `SYNC_DRIFT`'s notion
of "the track's most recent change" and any future logic that reads
track completion to decide what to push should be built against the
corrected track-status model, not the currently-broken one).

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
**depends_on:** `T5`, `T2.16` (added 2026-08-29 — `kt_check_drift`'s
project-wide scan and `STALE_TRACK`/`DEPENDENCY_GAP` heuristics reason
about track status directly; building them against the current
never-reaches-`done` model would bake the bug into T6's own test
fixtures).

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
   `CHANGELOG.md` entry. depends_on: `T7.5`, `T7.7`.
7. **T7.7 — Migration rollback (`migrate down`) mode implemented +
   verified.** Sequenced here 2026-08-28 (was `T9.x`/unscheduled in this
   doc's backlog — "deferred until a real forward migration actually
   needs reverting"; re-sequenced instead of left open because shipping
   a public release whose own `T2.1` acceptance criterion ("`migrate
   down` cleanly reverses `001_init.sql`") was never actually kept true
   is exactly the kind of half-measure this pass is trying to close out,
   not because a real forward migration has hit the need yet).
   Acceptance: `scripts/migrate.ts` gains a guarded down mode that runs
   `.down.sql` files in reverse order and removes their ledger entries;
   run against a Railway (or Render/Fly, once `T7.1`/`T7.2` exist) copy
   with real data, migrate up then down then up again, with a passing
   test confirming the schema and ledger match the pre-down state
   exactly. depends_on: `T2.1`, `T7.1`, `T7.2`.

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
   and per `T2.16`'s derived-status model there is nothing else to
   write: `on_track`/`blocked`/`done` are computed at read time from
   item status, so backfilling items to `done` is sufficient for their
   tracks to read as `done` too, with no separate track-status seeding
   step); any real pivot that occurred during T1–T7 is additionally
   recorded via `kt_record_decision` so the audit trail isn't silently
   backdated (one that has since been resolved is recorded via
   `kt_record_decision(resolves_pivot: true)`, not left
   `pivot_pending`). depends_on: `T8.2`, `T2.16`.
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
        # No `status` argument: kt_create_track's input schema is
        # .strict() with no such field (adversarial PR review finding —
        # an earlier draft passed one here) — the tool derives
        # on_track/blocked itself from whether `depends_on` tracks are
        # already done, which is exactly "on_track for T1, else blocked"
        # for this seed data since T1 is the only track with no
        # dependencies.
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

# This document only tracks Track-level status (each Track's "Status:"
# line above), not a formal per-Item status field — so "every completed
# Item under T1-T7" (T8.3's acceptance criterion) isn't something this
# pseudocode can compute from `item` alone. `items_completed_at_cutover`
# and `historical_pivots` are the operator's real, as-of-cutover inputs
# (built by walking T1-T7 against the actual shipped state, same as any
# other Track/Item status judgment call in this document), supplied here
# rather than invented. Both use plain roadmap labels ("T3", "T3.2") as
# their only identifier shape, consistently, so every lookup below goes
# through the same track_id[...] / item_id[...] maps built above — never
# a mix of a label used as a dict key and an object with attributes
# (adversarial PR review finding: an earlier draft mixed `item` used both
# as an `item_id` dict key and as an object exposing `.track_id`, which
# would raise a TypeError/KeyError at the first entry).
items_completed_at_cutover = [
    # {"item": "<roadmap Item id, e.g. 'T3.2'>", "track": "<its roadmap Track id, e.g. 'T3'>"}
    # ...
]
historical_pivots = [
    # {"track": "<roadmap Track id>", "title": ..., "rationale": ...,
    #  "what_changed": ..., "already_resolved": <bool>}
    # ...
]

# One call per track touched by either loop below — never a single call
# spanning T1-T8: kt_record_session_summary requires every id in
# `items_touched` to belong to the single `track_id` passed alongside it
# (src/mcp/tools/record-session-summary.ts rejects a mixed-track list,
# adversarial PR review finding on an earlier draft of this pseudocode).
# Seeding every touched track's key with `[]` up front — instead of only
# adding a key when an item is backfilled into it — means a track whose
# only T1-T7 activity was a pivot (no completed item) still gets a
# session-summary entry below (adversarial PR review finding: a prior
# draft only populated this dict from the item-backfill loop, so a
# pivot-only track's kt_record_decision call had no matching
# kt_record_session_summary at all).
touched_tracks = {p["track"] for p in historical_pivots} | {
    e["track"] for e in items_completed_at_cutover
}
backfilled_by_track = {track_key: [] for track_key in touched_tracks}

for entry in items_completed_at_cutover:
    # project_id is required by updateItemStatusInputSchema alongside
    # item_id and status (adversarial PR review finding — an earlier
    # draft omitted it here).
    kt_update_item_status(
        project_id = project.id,
        item_id    = item_id[entry["item"]],
        status     = "done",
    )
    backfilled_by_track[entry["track"]].append(item_id[entry["item"]])

for pivot in historical_pivots:                       # any real pivot that
    kt_record_decision(                               # occurred during T1-T7.
        project_id     = project.id,                  # kt_record_decision's
        track_id       = track_id[pivot["track"]],    # actual (already-shipped,
        title          = pivot["title"],              # T2.10) contract requires
        rationale      = pivot["rationale"],          # all four of project_id/
        what_changed   = pivot["what_changed"],       # track_id/title/rationale/
        resolves_pivot = pivot["already_resolved"],   # what_changed — there's no
    )                                                  # free-text-only form
    # `resolves_pivot` is T2.16's addition to this call — safe to rely on
    # here because T8.3 depends_on T2.16 (both land, in order, before T8
    # ever runs).

# T8.3's acceptance criterion is the loops above actually running — these
# summaries are a record of that having happened, not a substitute for it
# (adversarial PR review finding: an earlier draft created Tracks/Items
# and then wrote a summary claiming the backfill happened without ever
# calling kt_update_item_status/kt_record_decision). `items_touched=[]` is
# valid for a pivot-only track — the schema defaults it to an empty array
# and only validates track membership when the list is non-empty.
for track_key, items in backfilled_by_track.items():
    kt_record_session_summary(
        project_id    = project.id,
        track_id      = track_id[track_key],
        summary_text  = f"Backfilled {track_key} historical status to match "
                         "reality as of the cutover date.",
        files_touched = ["docs/ROADMAP.md"],
        items_touched = items,
    )

kt_record_session_summary(
    project_id    = project.id,
    track_id      = track_id["T8"],
    summary_text  = "Seeded KnoTrack's own roadmap (docs/ROADMAP.md) as the "
                     "initial Tracks/Items; T1-T7 historical status backfilled "
                     "and recorded per-track above.",
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

**Borrowed:**
- **`T9.x` — thin CLI wrapper. Done, no longer a backlog item.**
  `scripts/get-project-status-cli.ts` (`npm run get-project-status --
  <project_id>`) calls `getProjectStatusService` directly — no MCP
  transport, no server process, no agent involved — and prints the same
  JSON `kt_get_project_status` returns. Compiled to
  `dist/scripts/get-project-status-cli.js` for the same Docker-runtime
  invocation form `scripts/migrate.ts`/`scripts/rotate-encryption-key.ts`
  already document (the runtime image strips `tsx` and doesn't copy
  `scripts/*.ts`).
- **`T9.x` — companion `SKILL.md`. Done, no longer a backlog item.**
  `SKILL.md` (repo root) documents the CLI wrapper above as a second,
  lower-effort discovery path for harnesses that pick up the `SKILL.md`
  convention but haven't wired up the MCP server directly. Note: this repo
  does not actually have an `AGENTS.md` file today — the line above about
  "pairing our existing `AGENTS.md` breadcrumb" was aspirational, not
  accurate at the time it was written; `SKILL.md` stands on its own.
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

**Deferred from the v1 adversarial review — each item below carries its own justification
inline, re-verified against current code as of this entry rather than merely restated from the
review. The review run's `report.md` and `suppressions.json` (under
`.adversarial-review/run-20260823-020205/`) hold a fuller per-finding evidence trail — exact
repro steps, severity scoring, panel votes — but that directory is gitignored and local to the
machine the review ran on, not committed to this repo (re-run the `adversarial-review` skill to
regenerate it if that extra detail is ever needed); nothing below depends on it being available.
All items were confirmed real by direct code reading and judged disproportionate to fix
reactively under review pressure:**
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
- **`T9.x` — bound `files_touched` and adapter-secret input sizes. Done, no
  longer a backlog item.** `src/schemas/tools.ts`: `files_touched` now caps
  at 500 array entries (each entry was already capped at 1000 chars);
  `personal_access_token`/`api_key` cap at 512 chars, `repo`/`team_id` cap
  at 200 — generous relative to real token/identifier shapes, but a real
  ceiling against an authenticated caller submitting an arbitrarily large
  payload. (Finding `security-3`, final rerun.)
- **`T9.x` — stop disclosing Node.js version on unauthenticated `/info`.
  Done, no longer a backlog item.** `src/server/health-route.ts`'s `/info`
  handler no longer includes `node_version`; `docs/TRD.md` §8's example
  response and field list updated to match. (Finding `security-5`.)
- **`T9.x` — five test-coverage gaps. Done, no longer a backlog item.** All
  five added, no behavior change: (1) `tests/integration/record-session-summary.test.ts`
  — 404 when an `items_touched` id doesn't exist as an item at all. (2)
  `tests/unit/tool-helpers.test.ts` (new) — `runTool`'s success envelope,
  `KtError` envelope, and generic-error redaction/logging, exercised
  directly. (3) `tests/integration/register-project.test.ts` — Linear
  adapter credential encryption-at-rest, mirroring the existing GitHub
  test. (4) `tests/integration/get-project-status.test.ts` — `drift_flags`
  field mapping against an actually-open flag (previously only asserted
  the empty-array case). (5) `tests/integration/soft-deleted-project.test.ts`
  (new) — a project with `deleted_at` set is rejected (404) by every real
  service function that takes a `project_id`
  (`kt_get_project_status`/`kt_create_track`/`kt_create_item`/
  `kt_record_session_summary`; `kt_register_project` doesn't apply — see
  that file's header comment — and `kt_update_item_status`/
  `kt_record_decision` are still stubs). (Findings `test_quality-1`
  through `test_quality-5`.)
- **`T9.x` (new, unscheduled) — structured logging for drift-scan
  outcomes.** No log line records drift-scan duration, item count scanned,
  or flags raised per `kt_record_session_summary` call — an observability
  gap, not a correctness one. (Finding `reliability-6`.)

**Accepted risk, not a backlog item — the single shared-token trust model.**
Findings `security-1` (initial panel pass) and `security-3` (initial panel
pass — a *different* finding than the `security-3, final rerun` above; the
two review passes independently reused the same id number for unrelated
findings) argued that any valid bearer token can read/write any project on the
instance, including rotating another project's adapter credentials via
`kt_register_project`'s upsert. `docs/TRD.md` §4/§7 document this as the
deliberate v1 trust boundary — one instance, one operator, one trust domain;
isolating two teams means running two instances — not an omission. Suppression
expires 2027-02-23. Revisit only if a genuine multi-tenant (multiple mutually
untrusting operators on one instance) need shows up; until then, nothing to
build.

**Deferred from PR #1's CodeRabbit review round (2026-08-23/24) — architecture/
scope decisions, not bugs, per the `clear-decisions` walkthrough:**
- **Superseded 2026-08-28, now scheduled as `T2.16` — a path to unblock
  a `blocked` track.** Originally logged here as `T9.x`/unscheduled with
  "deferred until a real caller actually hits this." Re-investigated
  because the categorization itself was checked rather than trusted: the
  real gap is one level deeper than this bullet said — no track can ever
  reach `done` at all in normal operation (see `T2.16` above for the
  full trace through `docs/TRD.md` §3.5 and `kt_create_track`'s own
  logic), which is *why* nothing ever unblocks a dependent. Design
  revised again 2026-08-29 and decided by Paul the same day (derived
  status, not a stored+cascade patch, plus the `resolves_pivot`
  mechanism — see `T2.16`'s revision note); not yet built.
- **Still unscheduled, but with a stated trigger now (2026-08-28) —
  `@modelcontextprotocol/sdk` v1 → v2 migration.** Needed for
  `server/discover` and the 2026-07-28 protocol revision's stateless
  discovery mechanism. Breaking (modular v2 packages, ESM-first, Zod
  `^4.2.0` requirement), touches every tool registration and the core
  transport — genuinely too large to schedule speculatively. Revisit
  at `T4` (second-client verification) and `T7.1`/`T7.2` (the two
  untested deploy paths): if any client KnoTrack claims compatibility
  with actually requires `server/discover` to connect at all, that's
  the forcing function; if every verification passes on v1, stays
  deferred past `v1.0.0`.
- **Superseded 2026-08-28, now scheduled as `T7.7` — migration rollback
  (`down`) mode.** Was `T9.x`/unscheduled, "deferred until a real
  forward migration actually needs reverting." Re-sequenced into
  release prep instead: `T2.1`'s own acceptance criterion already
  promised this works, a public v1.0.0 shouldn't ship having quietly
  dropped that promise, and there's no reason to wait for an accidental
  forcing case when it can be built and verified deliberately as part
  of release hardening.
- **`T9.x` (new, unscheduled) — finish propagating the source_type/
  source_ref registration model through the remaining docs.** Commits
  `5809ae4`/`bca45ff` fixed the "13 tools"/ID-format/cross-track-deps/
  credential-contract drift in `PRD.md` sections 4.1, 4.4, 4.7, 5.3, and
  the Appendix, but did not touch: `kt_get_project_status`'s own PRD
  section (still describes a `{ project: { root_path, repo_url,
  adapters_enabled } }` shape that `get-project-status.ts` doesn't return
  at all — flagged as its own separate drift in commit `208c90b`, not
  re-verified this round); `kt_render_roadmap`, `kt_sync_to_github`, and
  `kt_sync_to_linear`'s PRD sections §4.12–4.14; and one stray
  `root_path`/`repo_url` mention in PRD.md §6's glossary. This is not
  speculative work waiting on real handlers: all three tools are
  unimplemented stubs, but `src/mcp/tools/stubs.ts` registers each one's
  real Zod schema from `src/schemas/tools.ts`, and `tools/list` already
  publishes those schemas to clients today — so the contradiction with
  the PRD prose is live now, not merely anticipated. Concretely:
  `kt_render_roadmap`'s schema takes `project_id` + `format`
  (`'markdown' | 'mermaid'`) with no `output_path` field at all, while
  PRD §4.12's acceptance criteria are written entirely around a
  `root_path`/`output_path` file-writing behavior the schema has no way
  to express; `kt_sync_to_github` and `kt_sync_to_linear` both take only
  `project_id` + `track_id`, while PRD §4.13/§4.14 gate on
  `adapters_enabled`, a field the current `source_type`/`source_ref`
  registration model (PRD §4.1) no longer has. Needs a pass once
  `kt_get_project_status` is re-verified against real code — but the
  three stub sections' prose can and should be fixed now, against the
  schemas already shipping.

**Deferred from a documentation-completeness audit (2026-08-24), prompted
by "do we have clarity on the gaps and how it maps to the roadmap":**
- **Fixed in this same round, not a backlog item — TRD.md's Appendix A
  and §5 described a schema that was never built.** TRD Appendix A
  carried a full hand-copied DDL block that had drifted from the real
  schema (`migrations/001_init.sql`) across nearly every table: a
  fictional `adapter_credentials` table instead of the real `adapters`
  table; a `projects.adapters` column and a non-nullable `source_ref`
  that don't exist; a `project_id` column directly on `items` that
  doesn't exist; a `drift_flags.flag_type`/`severity`/`status` shape
  where the real table has `kind`/`detail`/`resolved_at`; and no
  `api_tokens` table at all. §5's credential-storage description had the
  same `adapter_credentials`/`key_version` drift, independently
  discovered and partly self-documented already in
  `src/crypto/credential-cipher.ts`'s header comment. Fixed by pointing
  Appendix A at the real migration files instead of duplicating them
  (the duplication is what let this drift accumulate unnoticed), and
  correcting §5's storage/never-returned/known-gap bullets to match
  `src/db/queries/adapters.ts`. Also fixed: §1's Tech Stack table still
  named `node-pg-migrate` as the migration tool; the shipped build uses
  a hand-written raw-SQL + custom-runner approach instead
  (`scripts/migrate.ts`), and `node-pg-migrate` isn't even a project
  dependency. Also fixed `DATABASE_SCHEMA.md`'s top-of-doc "Migration
  tool" line, which had the same wrong claim and would have undermined
  this Appendix pointing readers there as the source of truth.
- **`T9.x` (new, unscheduled) — sweep remaining stale `node-pg-migrate`/
  `adapter_credentials` mentions.** This audit fixed the load-bearing
  instances (TRD §1/§5/Appendix A/B, `DATABASE_SCHEMA.md`'s top-of-doc
  migration-tool line) but didn't chase every mention repo-wide:
  `PRD.md` §5.3 (two `adapter_credentials` mentions), `ARCHITECTURE.md`
  (three `node-pg-migrate` mentions — tech-stack summary, component
  diagram label, and a deployment-topology aside), and
  `DATABASE_SCHEMA.md`'s two remaining secondary `node-pg-migrate`
  mentions (both in parenthetical rationale, lower-stakes than the
  top-of-doc claim already fixed). Also found this round but not fixed:
  TRD §2's Repository Layout tree listed the then-9 unimplemented tools
  as separate files under `src/mcp/tools/` when they were all actually
  in one `stubs.ts` — **partially resolved 2026-08-26**: `list-tracks.ts`
  and `get-track.ts` are now real files matching the tree (T2 build-out,
  first slice, below); `record-decision.ts` and `update-item-status.ts`
  are now real files too (T2 build-out, second slice, below), leaving 5
  still bundled in `stubs.ts`. `src/db/queries/decisions.ts` (also
  flagged here as not existing yet) now exists as well, shipped
  alongside `record-decision.ts` in that same second slice. Still open:
  TRD §2 shows a `src/adapters/` tree that doesn't exist at all yet
  (`T5` not started). This is not load-bearing the way the fixed ones
  were, but it's stale and should be swept when `T5` starts rather than
  piecemeal before then.
- **`T9.x` — encryption-key rotation. Done, no longer a backlog item.**
  This was flagged as live-now (not a pre-`T5` deferral), since
  `kt_register_project` (`T2.2`, already fully shipped) already accepts
  `adapters.github`/`adapters.linear` and calls `encryptCredential` +
  `upsertAdapter` today — adapter rows with real encrypted credentials
  can exist in any deployment before `T5`'s sync clients are even built.
  Shipped: `migrations/004_adapters_key_version.sql` adds
  `adapters.key_version integer NOT NULL DEFAULT 1`;
  `scripts/rotate-encryption-key.ts` (`npm run rotate-encryption-key`)
  reads the current key from `KNOTRACK_ENCRYPTION_KEY` and the new key
  from `KNOTRACK_ENCRYPTION_KEY_NEW`, decrypts every `adapters` row with
  the current key, re-encrypts with the new key, and bumps `key_version`
  — all inside one transaction, so a failure partway through rolls back
  every row instead of leaving a mix of old- and new-key rows. See TRD §5
  for the operator runbook (run the script, then swap
  `KNOTRACK_ENCRYPTION_KEY` and redeploy — don't restart with the old key
  still configured in between). Covered by
  `tests/unit/rotate-encryption-key.test.ts` and
  `tests/integration/rotate-encryption-key.test.ts` (round-trips a real
  rotation, rejects rotating to the same key, and confirms a wrong
  current key rolls back every row rather than partially rotating).
- **`T9.x` — `SYNC_DRIFT`'s missing schema. Decided and migrated; the drift
  rule itself is still unbuilt.** Paul chose (2026-08-25) columns directly
  on `tracks` over a `track_id`+`adapter_id` join table:
  `last_github_sync_at`/`last_linear_sync_at timestamptz`, nullable,
  shipped in `migrations/005_tracks_sync_timestamps.sql`. Rationale (full
  detail in that migration's header comment and `docs/TRD.md` Appendix
  B): `uq_adapters_project_type` allows only one `adapters` row per
  `(project_id, type)`, so an `adapters`-scoped column would make every
  track in a project share one timestamp — syncing track A would
  silently make track B look up to date too. A `tracks`-scoped column
  has no such sharing problem. The join-table alternative was considered
  and rejected: `kt_sync_to_github`/`kt_sync_to_linear` take
  `(project_id, track_id)`, not an `adapter_id`, and
  `uq_adapters_project_type` already rules out the "one track needs two
  adapters of the same type" case a join table would exist to handle —
  so it would add a join with nothing real to join against. This closes
  only the schema gap: `SYNC_DRIFT` the drift-flag rule is still unbuilt
  (`drift_flags.kind`'s CHECK still doesn't have a sync-drift value
  either), and `kt_sync_to_github`/`kt_sync_to_linear` are still stub
  registrations — both remain real T5/T6 work, not started.
- **Process note, not a backlog item — `T1.6`'s sign-off gate has never
  formally closed.** `T1.6`'s acceptance criterion is a cross-document
  consistency pass with "zero open discrepancies," recorded in
  `docs/SIGNOFF.md` — that file doesn't exist in this repo. This audit
  alone found three more discrepancies beyond the ones already fixed
  across PR #1/#2 (the T2 planned-vs-shipped gap and the TRD Appendix
  A/§5/§1 drift above), which is itself evidence `T1.6` was never
  actually satisfied — not a new problem to fix here, just worth naming
  plainly rather than treating "T1 done, T2 blocked" as literal status
  (see the reconciliation note under `T2`, above).
- **Process note, not a backlog item — spec-sync discipline for future
  commits.** PR #5 shipped new `.max()`/`.max()` Zod bounds in
  `src/schemas/tools.ts` without updating `docs/TRD.md`'s matching
  JSON-schema examples in the same commit; Codex caught the drift as a
  separate review finding, fixed reactively (`e499a5c5`). Separately,
  `migrations/004_adapters_key_version.sql` (PR #4) added
  `adapters.key_version` without `docs/DATABASE_SCHEMA.md`'s `adapters`
  table row ever getting it — caught only during this audit, by hand, not
  by either review bot. Neither is architecture-significant on its own,
  but two independent instances of the same failure mode (borrowed from
  reviewing [automazeio/ccpm's "No Vibe Coding" principle](https://github.com/automazeio/ccpm#core-principle-no-vibe-coding),
  which names this exact drift as the thing spec-first discipline is
  meant to prevent) is a pattern worth naming: **a commit that changes a
  tool's input/output shape, an endpoint's response shape, or a table's
  columns should update every doc that documents that shape in the same
  commit** — `docs/TRD.md` §3's JSON-schema blocks and `docs/DATABASE_SCHEMA.md`'s
  column tables, specifically — not leave it for review to catch after
  the fact.
- **`T2.5`/`T2.6` — `kt_list_tracks`/`kt_get_track` implemented + tested
  (T2 build-out, first of 3 planned PRs covering the 6 tools T2 still
  needs, 2026-08-26).** Before this PR, 6 tools were left to build for
  T2 (`kt_list_tracks`, `kt_get_track`, `kt_get_next_steps`,
  `kt_record_decision`, `kt_update_item_status`, `kt_render_roadmap`).
  This PR ships the first 2, leaving 4 T2 tools plus 3 stubs that are
  deliberately out of T2 scope (`kt_check_drift` → `T6`;
  `kt_sync_to_github`/`kt_sync_to_linear` → `T5`) — 7 total still in
  `stubs.ts`, matching this section's own header above.
  Both against the existing schema, no migration needed. `kt_list_tracks`:
  new `listTracksForListing` query (`src/db/queries/tracks.ts`) extends
  the existing item-counts aggregate with an optional `status` filter and
  each track's own `depends_on_track_ids` (kept as its own query rather
  than changing `listTracksWithItemCounts`, which `kt_get_project_status`
  already depends on). `kt_get_track`: entirely reused existing query
  helpers (`findTrackById`, `listItemsByTrack`,
  `getItemDependencyEdgesForTrack`) plus one new one-track-scoped
  `getDependsOnTrackIds`; no new query patterns needed. Both use
  `withReadSnapshot` (one consistent DB snapshot per call, same as
  `kt_get_project_status`). 12 new integration tests
  (`tests/integration/list-tracks.test.ts`, `get-track.test.ts`), full
  suite 108/108 passing. One deliberate deviation from `docs/TEST_CASES.md`'s
  literal LTRK-08/GTRK-08/GTRK-09 wording, worth recording since it's easy
  to miss on a future read: those rows describe a per-token/per-project
  auth scoping model ("token for P2, `project_id`=P1 → 404") that doesn't
  exist in this build — `KNOTRACK_API_TOKENS` is one flat pool with no
  per-project scoping (`src/server/auth.ts`, TRD §4) — so the tests
  instead assert the real remaining 404 case: a `track_id` that belongs
  to a different project than the `project_id` passed in, same token,
  which `findTrackById`'s `WHERE id = $1 AND project_id = $2` already
  enforces. Remaining T2 tools — `kt_get_next_steps`, `kt_record_decision`,
  `kt_update_item_status`, `kt_render_roadmap` — not started; `kt_render_roadmap`
  in particular needs new infrastructure this build doesn't have yet (a
  topological sort over `track_dependencies`, plus the wall-clock
  truncation/timeout budget TRD §6.3 requires), so it's planned as its
  own PR rather than bundled with the simpler write-path tools.
- **`T2.5`(cont.)/`T2.12` — `kt_get_next_steps`/`kt_render_roadmap` implemented
  + tested (T2 build-out, second of 3 planned PRs, 2026-08-26).** Before
  this PR, 4 T2 tools remained (`kt_get_next_steps`, `kt_record_decision`,
  `kt_update_item_status`, `kt_render_roadmap`). This PR ships these 2.
  **Update (this branch, PR #9):** the "leaving 2 T2 tools" and "5 total
  still in `stubs.ts`" counts below were accurate for PR #8 alone; this
  branch (PR #9) ships the remaining 2 (`kt_record_decision`,
  `kt_update_item_status`), leaving only the 3 tools deliberately out of
  T2 scope (`kt_check_drift` → `T6`; `kt_sync_to_github`/
  `kt_sync_to_linear` → `T5`) in `stubs.ts`. Preserved as originally
  written below: leaving 2 T2 tools (`kt_record_decision`,
  `kt_update_item_status`) plus the same 3 stubs deliberately out of T2
  scope (`kt_check_drift` → `T6`; `kt_sync_to_github`/`kt_sync_to_linear`
  → `T5`) — 5 total still in `stubs.ts` (down from 7 after PR #7,
  matching this build's running count in `docs/TRD.md` §2 and
  `README.md`'s tool table).
  `kt_get_next_steps`: new pure `rankNextSteps` (`src/domain/next-steps.ts`)
  implements TRD §3.8's steps 1-6 against three new/extended queries
  (`getTrackSummariesForProject` in `tracks.ts`; `listPendingItemsForProject`
  and `getItemStatusesByIds` — renamed from `getItemStatusesForProject`
  during PR #8's own review round — in `items.ts`) — no migration needed,
  same schema. `kt_render_roadmap`: the harder of the two, needing new
  infrastructure neither prior T2 tool had — a `topoSort` (Kahn's
  algorithm over the reversed `track_dependencies` edge direction, added
  to `src/domain/dependency-graph.ts` alongside `hasCycle`/`wouldCreateCycle`)
  and a pure `src/domain/roadmap-renderer.ts` for the markdown/mermaid
  string-building, both DB-free and unit-tested in isolation. The §6.3
  wall-clock truncation budget deliberately reuses `config.driftScanTimeoutMs`
  rather than inventing an undocumented `KNOTRACK_ROADMAP_TIMEOUT_MS` (no
  such env var exists in `src/config/env.ts`), and is implemented as a
  plain elapsed-time check between each track's item-query `await` rather
  than a literal `Promise.race` — a tight synchronous render loop can't be
  preempted by a pending timer on Node's single event loop, so a `race`
  wrapped around it would be dead code that looks like a safety net but
  isn't; see `render-roadmap.ts`'s top-of-file comment for the full
  reasoning, in the same style as `tool-helpers.ts`'s. Because that timing
  path is inherently non-deterministic to assert in CI, it's reasoned
  about in that comment rather than tested; the cap-based truncation path
  (`KNOTRACK_ROADMAP_TRACK_CAP`/`KNOTRACK_ROADMAP_ITEM_PER_TRACK_CAP`) is
  what's actually covered, by integration tests that override those caps
  on a cloned test config. 26 new unit tests (`topoSort` cases added to
  the existing `dependency-graph.test.ts`; new `roadmap-renderer.test.ts`
  and `next-steps.test.ts`) plus 15 new integration tests
  (`get-next-steps.test.ts`, `render-roadmap.test.ts`) at initial push,
  full suite 149/149 passing; 10 more tests (a new
  `tests/unit/render-roadmap-timeout.test.ts` plus additional cases in
  `roadmap-renderer.test.ts`, `next-steps.test.ts`, and
  `render-roadmap.test.ts`) were added during PR #8's own review-round
  fix, bringing the final count to 51 new tests and full suite 159/159
  passing. One judgment call worth recording: TRD §3.8's fixed
  reason-template prose is `"All {n} dependencies complete — ..."` (always
  plural "dependencies"), but its own worked example for `n = 1` shows
  singular "dependency" — the prose and the example disagree with each
  other for exactly that case. This build follows the worked example
  (singular for `n = 1`, plural otherwise), matching the same
  singular/plural handling `kt_update_item_status`'s `"N unmet
  dependency/dependencies"` message already uses for the same reason: the
  concrete JSON example is the more authoritative statement of actual wire
  output, and the prose is the imprecise part.
