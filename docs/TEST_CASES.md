# KnoTrack MCP Server — Test Cases

Scope: the 14 MCP tools exposed by KnoTrack (self-hosted MCP server for project
management support). This document is the test-case spec a builder should be
able to implement against directly, without inventing missing cases.

## 0. Conventions & Assumptions

These are fixed once here so individual rows don't repeat the reasoning.

1. **Cross-tenant reference status code: 404, not 403.** When a caller's
   bearer token is valid but the `project_id`/`track_id`/`item_id` in the
   request belongs to a *different* token's project, every tool returns
   **404 Not Found**, identical in shape to a genuinely nonexistent ID. This
   is a single-tenant-per-deployment system where a deployment can still
   hold multiple projects under different tokens; a 403 would confirm to an
   attacker that the ID *exists* but isn't theirs (information disclosure
   via status-code oracle). 404 gives the same signal for "doesn't exist"
   and "not yours," which is the safer default. All test rows below use 404
   for this case; if an implementation deliberately chooses 403 instead, it
   must do so consistently across all 14 tools and all ID types (project,
   track, item) — a mix of 403 and 404 depending on which ID mismatches is
   itself a bug worth its own test (see AUTH-08).
2. **Auth failure status code: 401** for missing, malformed, expired, or
   revoked tokens — always, on every tool, no exceptions (per spec). 401 is
   returned *before* any ID/ownership check runs, so an invalid token
   against a nonexistent project still yields 401, not 404 (see AUTH-07).
3. **Validation failure status code: 400** for missing required fields,
   wrong types, and out-of-enum values, unless a more specific code applies
   (404 for a dangling reference to another entity, 409 for a dependency
   cycle).
4. **Dependency-cycle status code: 409 Conflict**, and the create call must
   be fully rejected — no partial track/item is persisted.
5. **IDs.** `project_id`, `track_id`, `item_id`, `event_id`, `decision_id`
   are opaque server-generated identifiers. "Nonexistent ID" test rows use a
   syntactically well-formed but never-issued ID (e.g. a fresh random
   UUID/ULID matching the ID format) rather than a malformed string, to
   isolate "not found" from "bad format" (malformed-ID-shape is its own
   400-level test where noted).
6. **Dependency-cycle constructibility.** `depends_on` is only ever supplied
   at creation time (`kt_create_track`, `kt_create_item`), and it may only
   reference IDs that already exist at call time — there is no tool that
   edits an existing track's or item's dependency list afterward. Under
   normal single-threaded use this makes the dependency graph acyclic by
   construction (edges always point to already-created, hence
   topologically-earlier, nodes). The cycle-rejection requirement therefore
   matters most as a **defense-in-depth guard**, exercised in practice by:
   (a) a client that predicts or has otherwise obtained an ID before its
   owning create call is acknowledged (sequential/derivable IDs, a leaked ID
   from a failed/retried call, or a test harness with direct access to the
   ID-allocation step) attempting to close a loop back onto it; and (b) two
   concurrent create calls racing to reference each other's in-flight IDs
   (see CYC-07/CYC-08, which double as concurrency tests). The cycle tests
   below (CYC-01..CYC-06) describe the required contract in the conventional
   self/2-node/3-node shape; where a given deployment's ID scheme makes a
   case impossible to reach purely through the public MCP surface, it must
   still be verified against the underlying dependency-validation routine
   directly (unit/integration level below the MCP boundary) — the 409
   contract does not become optional just because black-box reachability is
   hard.
7. **"Never writes" assertions** (`kt_get_next_steps`, `kt_render_roadmap`)
   are checked by comparing a full DB snapshot (or at minimum: row counts
   for tracks/items/events/decisions, every `updated_at`, and the drift-flag
   set) taken immediately before and immediately after the call — they must
   be byte-identical.
8. **Adapter credential leakage** is checked by taking the complete raw JSON
   response body of a tool call and asserting the configured adapter
   credential value (and any substring of it ≥ 8 chars) does not appear
   anywhere in it, including nested in `recent_events`, `dependency_graph`,
   error messages, or `source_ref` echoes.
9. Test IDs are grouped by prefix: `AUTH-*` (cross-cutting auth),
   `REG/STAT/LTRK/GTRK/NEXT/CTRK/CITM/SESS/DEC/UIST/CDRF/ROAD/GHSY/LNSY-*`
   (one prefix per tool, in the order given in the spec), `CYC-*`
   (dependency cycles), `CONC-*` (concurrency), `DRIFT-*` (drift-detection
   semantics, as distinct from the `kt_check_drift` tool's own request/response
   contract which lives under `CDRF-*`), and `ADAPT-*` (adapter behavior and
   credential-leakage sweep).

---

## 1. Cross-Cutting Auth Tests

These patterns apply identically to **all 14 tools**. This section is the
canonical, exhaustive matrix; the per-tool sections below include only the
one or two auth rows most relevant to that tool's shape, and reference this
section for the rest — a full test suite replicates AUTH-01..AUTH-08 against
every tool, not just the representative tool shown here (`kt_get_project_status`).

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| AUTH-01 | All tools (rep.: `kt_get_project_status`) | Positive | Valid project exists; caller holds the token that created it | Valid bearer token in `Authorization` header; valid `project_id` | 200; normal payload returned |
| AUTH-02 | All tools | Negative | Valid project exists | No `Authorization` header at all | 401; no payload data leaked (no project fields in error body) |
| AUTH-03 | All tools | Negative | Valid project exists | `Authorization: Bearer ` with empty token string | 401 |
| AUTH-04 | All tools | Negative | Valid project exists | Malformed token (random non-JWT/non-opaque garbage string, e.g. `"Bearer lol"`) | 401; server does not throw/500 on parse failure |
| AUTH-05 | All tools | Negative | A token that was valid but has since passed its expiry timestamp | Expired bearer token | 401 (not 200 with stale claims) |
| AUTH-06 | All tools | Negative | A token that was valid but has been explicitly revoked (e.g. project deleted, token rotated) | Revoked bearer token | 401 |
| AUTH-07 | All tools | Negative | Token is invalid AND the referenced `project_id` does not exist either | Invalid/expired token + nonexistent `project_id` | 401 (auth check short-circuits before existence check — never 404) |
| AUTH-08 | All tools | Negative | Two projects P1 (token T1) and P2 (token T2) both exist | Call with token T2 against P1's `project_id` | 404 (per Convention #1) — verify this is consistent across all 14 tools and all ID kinds (project/track/item), not just project-level |
| AUTH-09 | All tools | Negative | Valid project exists | Bearer token belonging to a *different, entirely unrelated* deployment/tenant format (e.g. right shape, signed by a different key) | 401, not 404 — signature/issuer invalidity is an auth failure, not a scoping failure |

---

## 2. `kt_register_project`

`kt_register_project(name, source_type: github|linear|local, source_ref, adapters?) -> {project_id}`

Note on (d)/(e) from the task brief: this tool creates a project rather than
referencing one, so "nonexistent project" and "cross-tenant project" don't
apply to its own input the way they do to the other 12 tools. REG-08/REG-09
below substitute the closest meaningful analogues (an unreachable/invalid
`source_ref`, and adapter config that references credentials for a different
tenant) so the tool isn't left with a gap.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| REG-01 | kt_register_project | Positive | None | `name="Storefront Revamp"`, `source_type="github"`, `source_ref="org/repo"` | 200/201; `{project_id}` returned, non-empty, unique |
| REG-02 | kt_register_project | Positive | None | `source_type="linear"`, `source_ref="<linear-project-id>"` | 200/201; `{project_id}` returned |
| REG-03 | kt_register_project | Positive | None | `source_type="local"`, `source_ref="/abs/path"` | 200/201; `{project_id}` returned |
| REG-04 | kt_register_project | Positive | None | Valid required fields + `adapters={github:{token:"..."}}` | 200/201; `{project_id}` returned; response body contains no adapter token (see ADAPT-05) |
| REG-05 | kt_register_project | Negative | None | `name` omitted | 400; error identifies `name` as missing |
| REG-06 | kt_register_project | Negative | None | `name=""` (empty string) | 400 |
| REG-07 | kt_register_project | Negative | None | `source_type="gitlab"` (not in `github\|linear\|local` enum) | 400; error names the invalid enum value |
| REG-08 | kt_register_project | Negative | None | `source_type` omitted entirely | 400 |
| REG-09 | kt_register_project | Negative | None | `source_ref` omitted | 400 |
| REG-10 | kt_register_project | Negative | None | `source_type="github"`, `source_ref=""` | 400 |
| REG-11 | kt_register_project | Negative | None | `adapters` malformed (e.g. `adapters="not-an-object"`) | 400; does not silently drop the field and succeed |
| REG-12 | kt_register_project | Negative | None | `adapters={slack:{...}}` — an adapter kind KnoTrack doesn't support | 400 (unknown adapter kind) rather than silently accepted and later failing opaquely at sync time |
| REG-13 | kt_register_project | Negative (auth) | None | Missing bearer token | 401 |
| REG-14 | kt_register_project | Negative (auth) | None | Malformed bearer token | 401 |
| REG-15 | kt_register_project | Positive | None | Two calls with identical `name`/`source_type`/`source_ref` | Both succeed with two distinct `project_id`s (no implicit uniqueness constraint on name) — or, if the implementation *does* enforce uniqueness, the second call returns a defined 409/400 rather than silently returning the first project's ID. Pick one behavior and assert it consistently. |

---

## 3. `kt_get_project_status`

`kt_get_project_status(project_id) -> {tracks, drift_flags, recent_events}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| STAT-01 | kt_get_project_status | Positive | Project exists with ≥2 tracks, ≥1 drift flag, ≥1 event | Valid token + `project_id` | 200; `tracks`, `drift_flags`, `recent_events` all populated and consistent with DB state |
| STAT-02 | kt_get_project_status | Positive | Freshly registered project, no tracks/events yet | Valid token + `project_id` | 200; `tracks=[]`, `drift_flags=[]`, `recent_events=[]` (empty, not null/error) |
| STAT-03 | kt_get_project_status | Negative | None | `project_id` omitted | 400 |
| STAT-04 | kt_get_project_status | Negative | None | `project_id` is a syntactically malformed ID (wrong shape) | 400 (distinct from 404 — bad shape vs. absent record) |
| STAT-05 | kt_get_project_status | Negative (auth) | Project exists | Missing bearer token | 401 |
| STAT-06 | kt_get_project_status | Negative (auth) | Project exists | Invalid/garbage bearer token | 401 |
| STAT-07 | kt_get_project_status | Negative | None | Well-formed but never-issued `project_id` | 404 |
| STAT-08 | kt_get_project_status | Negative | Project P1 (token T1) and P2 (token T2) exist | Token T2, `project_id` = P1's | 404 (Convention #1) |
| STAT-09 | kt_get_project_status | Negative | Project has a github adapter configured with a credential | Valid call | 200; response body contains no adapter credential anywhere (see ADAPT-05) |

---

## 4. `kt_list_tracks`

`kt_list_tracks(project_id, status?) -> {tracks}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| LTRK-01 | kt_list_tracks | Positive | Project has tracks in mixed statuses | `project_id` only, no `status` filter | 200; all tracks for the project returned |
| LTRK-02 | kt_list_tracks | Positive | Project has tracks in mixed statuses | `status="in_progress"` (or whatever the track-status enum defines) | 200; only tracks matching that status returned |
| LTRK-03 | kt_list_tracks | Positive | Project has zero tracks matching a given status | `status="blocked"` where none are blocked | 200; `tracks=[]` |
| LTRK-04 | kt_list_tracks | Negative | Project exists | `status="not-a-real-status"` | 400 (invalid enum value) |
| LTRK-05 | kt_list_tracks | Negative | None | `project_id` omitted | 400 |
| LTRK-06 | kt_list_tracks | Negative (auth) | Project exists | Missing token | 401 |
| LTRK-07 | kt_list_tracks | Negative | None | Nonexistent `project_id` | 404 |
| LTRK-08 | kt_list_tracks | Negative | Two projects, two tokens | Token for P2, `project_id` = P1 | 404 |
| LTRK-09 | kt_list_tracks | Positive | Project has tracks each with dependencies on other tracks | No filter | 200; `tracks` list does not itself need to include full dependency graphs (that's `kt_get_track`'s job) but each track's own summary fields are internally consistent with `kt_get_track` for the same ID |

---

## 5. `kt_get_track`

`kt_get_track(project_id, track_id) -> {track, items, dependency_graph}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| GTRK-01 | kt_get_track | Positive | Track exists with items and a dependency edge to another track | Valid `project_id` + `track_id` | 200; `track`, `items`, `dependency_graph` all returned and consistent with DB |
| GTRK-02 | kt_get_track | Positive | Track exists with zero items | Valid IDs | 200; `items=[]`, `dependency_graph` reflects track-level deps only |
| GTRK-03 | kt_get_track | Negative | Project exists | `track_id` omitted | 400 |
| GTRK-04 | kt_get_track | Negative | None | `project_id` omitted | 400 |
| GTRK-05 | kt_get_track | Negative (auth) | Track exists | Missing token | 401 |
| GTRK-06 | kt_get_track | Negative | Project exists | Nonexistent `project_id`, any `track_id` | 404 |
| GTRK-07 | kt_get_track | Negative | Project exists | Valid `project_id`, nonexistent `track_id` | 404 |
| GTRK-08 | kt_get_track | Negative | Two projects, two tokens | Token for P2, correct `project_id`=P2 but `track_id` belongs to P1 | 404 (track doesn't belong to this project even though the project_id itself is valid and owned by the caller) |
| GTRK-09 | kt_get_track | Negative | Two projects, two tokens | Token for P2, `project_id`=P1, `track_id` belongs to P1 | 404 (Convention #1, project-level mismatch) |
| GTRK-10 | kt_get_track | Positive | Track has a chain of 3 dependent tracks (A→B→C) | Get track C | 200; `dependency_graph` correctly shows the full ancestor chain, not just direct parent |

---

## 6. `kt_get_next_steps` (tool-contract rows; see §12 for the dedicated advisory/no-write test set)

`kt_get_next_steps(project_id) -> {recommended_items}` — ADVISORY ONLY, must never write/assign anything.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| NEXT-01 | kt_get_next_steps | Positive | Project has unblocked items available | Valid `project_id` | 200; `recommended_items` populated |
| NEXT-02 | kt_get_next_steps | Negative | None | `project_id` omitted | 400 |
| NEXT-03 | kt_get_next_steps | Negative (auth) | Project exists | Missing token | 401 |
| NEXT-04 | kt_get_next_steps | Negative | None | Nonexistent `project_id` | 404 |
| NEXT-05 | kt_get_next_steps | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |

(Full behavioral coverage — unblocked-only filtering, empty-list cases,
never-writes assertion — is in §12, since the task calls these out as a
dedicated set distinct from the basic per-tool contract above.)

---

## 7. `kt_create_track`

`kt_create_track(project_id, title, depends_on?, source_doc_ref?) -> {track_id}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| CTRK-01 | kt_create_track | Positive | Project exists | `title="Auth rework"`, no `depends_on`, no `source_doc_ref` | 200/201; `{track_id}` returned |
| CTRK-02 | kt_create_track | Positive | Project has an existing track A | `title="Follow-up"`, `depends_on=[A]` | 200/201; `{track_id}`; `kt_get_track` on the new track shows A in `dependency_graph` |
| CTRK-03 | kt_create_track | Positive | Project exists | `title="Docs pass"`, `source_doc_ref="docs/spec.md#section-2"` | 200/201; `source_doc_ref` retrievable via `kt_get_track` |
| CTRK-04 | kt_create_track | Negative | Project exists | `title` omitted | 400 |
| CTRK-05 | kt_create_track | Negative | Project exists | `title=""` | 400 |
| CTRK-06 | kt_create_track | Negative | Project exists | `depends_on=["<nonexistent-track-id>"]` | 404 or 400 (dangling reference) — must not silently create the track with a broken edge |
| CTRK-07 | kt_create_track | Negative | Project P1 has track A; project P2 exists | Token for P2, `project_id=P2`, `depends_on=[A]` (A belongs to P1) | 404/400 — cross-project dependency edges must be rejected, not silently created (would otherwise leak P1's track ID's existence into P2's graph) |
| CTRK-08 | kt_create_track | Negative | None | `project_id` omitted | 400 |
| CTRK-09 | kt_create_track | Negative (auth) | Project exists | Missing token | 401 |
| CTRK-10 | kt_create_track | Negative | None | Nonexistent `project_id` | 404 |
| CTRK-11 | kt_create_track | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| CTRK-12 | kt_create_track | Negative | Project exists | `depends_on` is not an array (e.g. a bare string) | 400 |
| CTRK-13 | kt_create_track | See CYC-01/03/05 | — | Direct/2-node/3-node track cycles | 409 — cross-referenced in §11 |

---

## 8. `kt_create_item`

`kt_create_item(project_id, track_id, title, sequence_position?, depends_on?) -> {item_id}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| CITM-01 | kt_create_item | Positive | Track exists | `title="Write migration"`, no optional fields | 200/201; `{item_id}` returned; sequence_position auto-assigned (e.g. appended to end) |
| CITM-02 | kt_create_item | Positive | Track has items at positions 1,2,3 | `title="Insert here"`, `sequence_position=2` | 200/201; new item takes position 2; existing items at ≥2 shift consistently (verify via `kt_get_track`) |
| CITM-03 | kt_create_item | Positive | Track has item X | `title="Depends on X"`, `depends_on=[X]` | 200/201; `dependency_graph` for the track shows the edge |
| CITM-04 | kt_create_item | Negative | Track exists | `title` omitted | 400 |
| CITM-05 | kt_create_item | Negative | Track exists | `title=""` | 400 |
| CITM-06 | kt_create_item | Negative | Track exists | `sequence_position=-1` | 400 |
| CITM-07 | kt_create_item | Negative | Track exists | `sequence_position="two"` (wrong type) | 400 |
| CITM-08 | kt_create_item | Negative | Track exists | `depends_on=["<nonexistent-item-id>"]` | 404 NOT_FOUND — the id doesn't exist as an item at all |
| CITM-09 | kt_create_item | Negative | Track T1 has item X; track T2 exists in the same project | `track_id=T2`, `depends_on=[X]` (X belongs to T1) | 400 VALIDATION — cross-track item dependencies are not allowed; `depends_on` must belong to the same track as the item being created (docs/PRD.md §4.7) |
| CITM-10 | kt_create_item | Negative | Project P1 has item X; project P2 exists | Token for P2, `depends_on=[X]` (X belongs to P1) | 404 NOT_FOUND or 400 VALIDATION — X does not exist as an item in P2's track scope |
| CITM-11 | kt_create_item | Negative | None | `project_id` omitted | 400 |
| CITM-12 | kt_create_item | Negative | Project exists | `track_id` omitted | 400 |
| CITM-13 | kt_create_item | Negative (auth) | Track exists | Missing token | 401 |
| CITM-14 | kt_create_item | Negative | Project exists | Nonexistent `track_id` | 404 |
| CITM-15 | kt_create_item | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| CITM-16 | kt_create_item | Negative | Two projects, two tokens | Token for P2, `project_id=P2`, but `track_id` belongs to P1 | 404 |
| CITM-17 | kt_create_item | See CYC-02/04/06 | — | Direct/2-node/3-node item cycles | 409 — cross-referenced in §11 |

---

## 9. `kt_record_session_summary`

`kt_record_session_summary(project_id, track_id, summary_text, files_touched[], items_touched[]) -> {event_id, drift_flags_raised}` —
runs a structural drift check inline: flags if an item in `items_touched` has an
undone dependency, or if a file in `files_touched` doesn't map to any item in
the track.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| SESS-01 | kt_record_session_summary | Positive | Track/items exist, all dependencies satisfied, all files map to items | Valid `summary_text`, `files_touched=["src/a.ts"]` (mapped), `items_touched=[item with no undone deps]` | 200; `{event_id}` new & unique; `drift_flags_raised=[]` |
| SESS-02 | kt_record_session_summary | Positive (drift) | Item Y depends on item X; X is not done | `items_touched=[Y]` | 200; `event_id` returned; `drift_flags_raised` contains an "undone dependency" flag referencing X→Y |
| SESS-03 | kt_record_session_summary | Positive (drift) | Track has items, none mapped to `notes/scratch.md` | `files_touched=["notes/scratch.md"]` | 200; `drift_flags_raised` contains an "unmapped file" flag for that path |
| SESS-04 | kt_record_session_summary | Positive (drift) | Both SESS-02 and SESS-03 conditions true simultaneously | `items_touched=[Y]`, `files_touched=["notes/scratch.md"]` | 200; `drift_flags_raised` contains both flags (not just one) |
| SESS-05 | kt_record_session_summary | Positive | `files_touched=[]`, `items_touched=[]` (edge case: a summary with no touched artifacts) | Valid `summary_text` only | 200; `event_id` returned; `drift_flags_raised=[]` — must not error on empty arrays |
| SESS-06 | kt_record_session_summary | Negative | Track exists | `summary_text` omitted | 400 |
| SESS-07 | kt_record_session_summary | Negative | Track exists | `summary_text=""` | 400 |
| SESS-08 | kt_record_session_summary | Negative | Track exists | `files_touched` is not an array (e.g. a string) | 400 |
| SESS-09 | kt_record_session_summary | Negative | Track exists | `items_touched` is not an array | 400 |
| SESS-10 | kt_record_session_summary | Negative | Track exists | `items_touched=["<nonexistent-item-id>"]` | 404/400 — must not silently drop the unknown ID and succeed |
| SESS-11 | kt_record_session_summary | Negative | None | `project_id` omitted | 400 |
| SESS-12 | kt_record_session_summary | Negative | Project exists | `track_id` omitted | 400 |
| SESS-13 | kt_record_session_summary | Negative (auth) | Track exists | Missing token | 401 |
| SESS-14 | kt_record_session_summary | Negative | Project exists | Nonexistent `track_id` | 404 |
| SESS-15 | kt_record_session_summary | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| SESS-16 | kt_record_session_summary | Negative | Two projects, two tokens | Token for P2, `project_id=P2`, `track_id` belongs to P1 | 404 |
| SESS-17 | kt_record_session_summary | Negative | Project has github adapter with credential configured | Valid call | 200; response contains no adapter credential |
| SESS-18 | kt_record_session_summary | See CONC-01/02 | — | Two simultaneous calls on the same track | No corrupted `sequence_position`, no double-counted event — cross-referenced in §11.5 |

---

## 10. `kt_record_decision`

`kt_record_decision(project_id, track_id, title, rationale, what_changed) -> {decision_id}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| DEC-01 | kt_record_decision | Positive | Track exists | All fields populated with reasonable text | 200/201; `{decision_id}` returned, unique |
| DEC-02 | kt_record_decision | Negative | Track exists | `title` omitted | 400 |
| DEC-03 | kt_record_decision | Negative | Track exists | `rationale` omitted | 400 |
| DEC-04 | kt_record_decision | Negative | Track exists | `what_changed` omitted | 400 |
| DEC-05 | kt_record_decision | Negative | Track exists | `title=""` | 400 |
| DEC-06 | kt_record_decision | Negative | None | `project_id` omitted | 400 |
| DEC-07 | kt_record_decision | Negative | Project exists | `track_id` omitted | 400 |
| DEC-08 | kt_record_decision | Negative (auth) | Track exists | Missing token | 401 |
| DEC-09 | kt_record_decision | Negative | Project exists | Nonexistent `track_id` | 404 |
| DEC-10 | kt_record_decision | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| DEC-11 | kt_record_decision | Negative | Two projects, two tokens | Token for P2, `project_id=P2`, `track_id` belongs to P1 | 404 |
| DEC-12 | kt_record_decision | Positive | Decision recorded on track T | Subsequent `kt_get_project_status` / `kt_get_track` call | The decision surfaces appropriately in project history/events (verify it is durably persisted, not just acknowledged) |

---

## 11. `kt_update_item_status`

`kt_update_item_status(project_id, item_id, status: pending|in_progress|done|blocked) -> {ok}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| UIST-01 | kt_update_item_status | Positive | Item exists, `status=pending` | `status="in_progress"` | 200; `{ok:true}`; `kt_get_track` reflects new status |
| UIST-02 | kt_update_item_status | Positive | Item `in_progress` | `status="done"` | 200; `{ok:true}` |
| UIST-03 | kt_update_item_status | Positive | Item exists | `status="blocked"` | 200; `{ok:true}` |
| UIST-04 | kt_update_item_status | Positive | Item exists | `status="pending"` (reset) | 200; `{ok:true}` — no restriction on backward transitions unless spec says otherwise |
| UIST-05 | kt_update_item_status | Positive (edge) | Item Y depends on item X; X is still `pending` | `item_id=Y`, `status="done"` | 200; `{ok:true}` — the tool itself does not gate on dependency completion (only `kt_record_session_summary`'s inline check and `kt_check_drift` do); a subsequent `kt_check_drift` call MAY surface this as a flag depending on drift rules, but `kt_update_item_status` itself must not reject or silently no-op |
| UIST-06 | kt_update_item_status | Negative | Item exists | `status="cancelled"` (not in enum) | 400 |
| UIST-07 | kt_update_item_status | Negative | Item exists | `status` omitted | 400 |
| UIST-08 | kt_update_item_status | Negative | None | `item_id` omitted | 400 |
| UIST-09 | kt_update_item_status | Negative | None | `project_id` omitted | 400 |
| UIST-10 | kt_update_item_status | Negative (auth) | Item exists | Missing token | 401 |
| UIST-11 | kt_update_item_status | Negative | Project exists | Nonexistent `item_id` | 404 |
| UIST-12 | kt_update_item_status | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| UIST-13 | kt_update_item_status | Negative | Two projects, two tokens | Token for P2, `project_id=P2`, `item_id` belongs to P1 | 404 |

---

## 11.5 `kt_check_drift` (tool contract; see §13 for drift-detection semantics)

`kt_check_drift(project_id) -> {flags}`

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| CDRF-01 | kt_check_drift | Positive | Project has no drift conditions present | Valid `project_id` | 200; `flags=[]` |
| CDRF-02 | kt_check_drift | Positive | Project has ≥1 active drift condition (e.g. undone-dependency touch) | Valid `project_id` | 200; `flags` non-empty, matching the actual condition |
| CDRF-03 | kt_check_drift | Negative | None | `project_id` omitted | 400 |
| CDRF-04 | kt_check_drift | Negative (auth) | Project exists | Missing token | 401 |
| CDRF-05 | kt_check_drift | Negative | None | Nonexistent `project_id` | 404 |
| CDRF-06 | kt_check_drift | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| CDRF-07 | kt_check_drift | Negative | Project has adapter credential configured | Valid call | 200; no credential present in response |

---

## 12. `kt_get_next_steps` — dedicated advisory / no-write test set

Per the task's requirement for dedicated depth beyond the basic tool
contract in §6.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| NEXT-10 | kt_get_next_steps | Positive | Track has items: A (done), B (blocked), C (pending, no deps), D (pending, depends on A/done) | Valid `project_id` | 200; `recommended_items` includes C and D; excludes A (done) and B (blocked) |
| NEXT-11 | kt_get_next_steps | Positive | Item E is pending but depends on item F which is not done | Valid `project_id` | 200; E is excluded from `recommended_items` (dependency not satisfied even though E's own status is "pending" not "blocked") |
| NEXT-12 | kt_get_next_steps | Positive | Every item in the project is either `done` or `blocked` | Valid `project_id` | 200; `recommended_items=[]` (not an error, not null) |
| NEXT-13 | kt_get_next_steps | Positive | Project has zero items at all | Valid `project_id` | 200; `recommended_items=[]` |
| NEXT-14 | kt_get_next_steps | Negative (explicit no-write assertion) | Full DB snapshot taken (row counts, `updated_at` timestamps, event log, drift flags, item statuses) | Call `kt_get_next_steps` | 200 with recommendations; post-call snapshot is **byte-identical** to pre-call snapshot — specifically: no new `event_id`, no item status changed, no drift flag added/removed, no track/item row touched |
| NEXT-15 | kt_get_next_steps | Negative (explicit no-write assertion) | Same as NEXT-14, called twice in a row | Call twice | Both calls return identical `recommended_items`; zero writes on either call; calling it does not itself "consume" or de-prioritize a recommendation |
| NEXT-16 | kt_get_next_steps | Positive | Track has an item chain A→B→C where A is done, B is in_progress, C depends on B | Valid `project_id` | 200; B appears (unblocked: its only dep A is done); C does not appear (its dep B is not done) |

---

## 13. Drift-Detection Semantics

Distinct from `kt_check_drift`'s own request/response contract (§11.5), this
section tests the *detection logic itself*, which is triggered both inline by
`kt_record_session_summary` and on-demand by `kt_check_drift`.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| DRIFT-01 | Drift detection | Positive | Item Y (in `items_touched`) depends on item X; X is `pending` | `kt_record_session_summary(items_touched=[Y], ...)` | `drift_flags_raised` includes an undone-dependency flag for X→Y; the same flag then appears in the next `kt_check_drift` call |
| DRIFT-02 | Drift detection | Positive | File `db/schema.sql` touched, no item in the track maps to it | `kt_record_session_summary(files_touched=["db/schema.sql"], ...)` | `drift_flags_raised` includes an unmapped-file flag for `db/schema.sql`; also visible in next `kt_check_drift` |
| DRIFT-03 | Drift detection | Positive (no flag) | Item Z has all dependencies `done`; every file touched maps to an item in the track | `kt_record_session_summary(items_touched=[Z], files_touched=[mapped files], ...)` | `drift_flags_raised=[]`; `kt_check_drift` immediately after also returns no new flag for this session |
| DRIFT-04 | Drift detection | Positive (resolution) | DRIFT-01's flag is active; dependency X is subsequently marked `done` via `kt_update_item_status` | Call `kt_check_drift` again | The undone-dependency flag for X→Y no longer appears — it does not persist as a stale/ghost flag once its triggering condition is resolved |
| DRIFT-05 | Drift detection | Positive (no reappearance) | DRIFT-04's flag was resolved; no new session touches Y or any dependency of Y | Call `kt_check_drift` repeatedly | The resolved flag never reappears absent the same condition recurring |
| DRIFT-06 | Drift detection | Positive (recurrence) | DRIFT-04's flag was resolved; item Y is later touched again while depending on a *different*, still-undone item W | `kt_record_session_summary(items_touched=[Y], ...)` where Y now depends on undone W | A new flag is raised for W→Y — this is a legitimately recurring condition (same item, different cause), not a suppressed duplicate |
| DRIFT-07 | Drift detection | Positive (multi-flag) | Item touched has an undone dependency AND a file touched is unmapped, in the same call | Single `kt_record_session_summary` call | Both flags appear in `drift_flags_raised`, and both persist to the next `kt_check_drift` |
| DRIFT-08 | Drift detection | Positive (idempotent check) | A flag is currently active | Call `kt_check_drift` twice in a row with no state change between | Both calls return the identical flag set (no duplication of the same flag on repeated checks) |
| DRIFT-09 | Drift detection | Positive (scope) | Two tracks in the same project; drift condition exists only in track A | `kt_check_drift(project_id)` (project-scoped, not track-scoped per the tool signature) | Returned `flags` are correctly attributed to track A only; track B's flags list (if flags carry track attribution) does not falsely include A's condition |

---

## 14. `kt_render_roadmap`

`kt_render_roadmap(project_id, format?) -> {content}` — pure function, must never write to the DB.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| ROAD-01 | kt_render_roadmap | Positive | Project has tracks/items in various states | `project_id` only, default `format` | 200; `content` returned, non-empty, reflects current tracks/items |
| ROAD-02 | kt_render_roadmap | Positive | Project exists | `format="markdown"` (or whichever formats are documented) | 200; `content` in the requested format |
| ROAD-03 | kt_render_roadmap | Negative | Project exists | `format="pdf"` (unsupported/undocumented format) | 400; error names the invalid format, does not silently fall back |
| ROAD-04 | kt_render_roadmap | Negative | None | `project_id` omitted | 400 |
| ROAD-05 | kt_render_roadmap | Negative (auth) | Project exists | Missing token | 401 |
| ROAD-06 | kt_render_roadmap | Negative | None | Nonexistent `project_id` | 404 |
| ROAD-07 | kt_render_roadmap | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| ROAD-08 | kt_render_roadmap | Positive (exact reflection) | Baseline roadmap rendered; then a new item is created via `kt_create_item` | Render roadmap again | New `content` includes the new item; differs from the baseline exactly where the DB differs and nowhere else |
| ROAD-09 | kt_render_roadmap | Positive (determinism) | No DB changes between calls | Call `kt_render_roadmap` twice in a row with identical arguments | Both calls return **byte-identical** `content` |
| ROAD-10 | kt_render_roadmap | Negative (explicit no-write assertion) | Full DB snapshot taken pre-call | Call `kt_render_roadmap` | Post-call snapshot is byte-identical to pre-call snapshot — no event logged, no `updated_at` touched, no drift flag created as a side effect of rendering |
| ROAD-11 | kt_render_roadmap | Negative | Project has adapter credential configured | Valid call | `content` contains no adapter credential, even if the roadmap text references the source repo/linear project |

---

## 15. `kt_sync_to_github`

`kt_sync_to_github(project_id, track_id) -> {ok} | {ok:false, error}` — only valid if a github adapter is configured for the project.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| GHSY-01 | kt_sync_to_github | Positive | Project has a working github adapter configured; track exists | Valid `project_id`, `track_id` | 200; `{ok:true}` (or documented success payload); no credential in response |
| GHSY-02 | kt_sync_to_github | Negative (clean error, not crash) | Project has **no** github adapter configured | Valid `project_id`, `track_id` | 200 (tool-level) with `{ok:false, error:"..."}` — NOT a 500, NOT an unhandled exception, NOT a generic 400 that hides the real cause |
| GHSY-03 | kt_sync_to_github | Negative | Project has a linear adapter but no github adapter | Same call | `{ok:false, error:"..."}` clearly indicating github specifically is not configured, not a generic failure |
| GHSY-04 | kt_sync_to_github | Negative | github adapter configured but its credential is invalid/expired at the remote end | Same call | `{ok:false, error:"..."}` — the remote auth failure is caught and surfaced cleanly, not a raw stack trace or crash |
| GHSY-05 | kt_sync_to_github | Negative | github adapter configured; remote GitHub API is unreachable/times out | Same call | `{ok:false, error:"..."}` — network failure handled gracefully |
| GHSY-06 | kt_sync_to_github | Negative | None | `track_id` omitted | 400 |
| GHSY-07 | kt_sync_to_github | Negative | None | `project_id` omitted | 400 |
| GHSY-08 | kt_sync_to_github | Negative (auth) | Adapter configured | Missing token | 401 |
| GHSY-09 | kt_sync_to_github | Negative | None | Nonexistent `project_id` | 404 |
| GHSY-10 | kt_sync_to_github | Negative | Project exists, adapter configured | Nonexistent `track_id` | 404 |
| GHSY-11 | kt_sync_to_github | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| GHSY-12 | kt_sync_to_github | Negative | Two projects, two tokens | Token for P2 (P2 has github adapter), `project_id=P2`, `track_id` belongs to P1 | 404 |
| GHSY-13 | kt_sync_to_github | Negative | github adapter configured with credential | Successful sync call (GHSY-01) | The success response body itself contains no credential — verify separately from the general adapter sweep in §16, since a successful sync is the highest-risk path for accidentally echoing adapter config back |

---

## 16. `kt_sync_to_linear`

`kt_sync_to_linear(project_id, track_id) -> {ok} | {ok:false, error}` — only valid if a linear adapter is configured. Mirror of §15.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| LNSY-01 | kt_sync_to_linear | Positive | Project has a working linear adapter configured; track exists | Valid `project_id`, `track_id` | 200; `{ok:true}`; no credential in response |
| LNSY-02 | kt_sync_to_linear | Negative (clean error, not crash) | Project has **no** linear adapter configured | Valid `project_id`, `track_id` | `{ok:false, error:"..."}`, not a crash/500 |
| LNSY-03 | kt_sync_to_linear | Negative | Project has a github adapter but no linear adapter | Same call | `{ok:false, error:"..."}` naming linear specifically |
| LNSY-04 | kt_sync_to_linear | Negative | linear adapter configured but credential invalid/expired | Same call | `{ok:false, error:"..."}` clean |
| LNSY-05 | kt_sync_to_linear | Negative | linear adapter configured; remote Linear API unreachable/times out | Same call | `{ok:false, error:"..."}` clean |
| LNSY-06 | kt_sync_to_linear | Negative | None | `track_id` omitted | 400 |
| LNSY-07 | kt_sync_to_linear | Negative | None | `project_id` omitted | 400 |
| LNSY-08 | kt_sync_to_linear | Negative (auth) | Adapter configured | Missing token | 401 |
| LNSY-09 | kt_sync_to_linear | Negative | None | Nonexistent `project_id` | 404 |
| LNSY-10 | kt_sync_to_linear | Negative | Project exists, adapter configured | Nonexistent `track_id` | 404 |
| LNSY-11 | kt_sync_to_linear | Negative | Two projects, two tokens | Wrong-tenant token/project pairing | 404 |
| LNSY-12 | kt_sync_to_linear | Negative | Two projects, two tokens | Token for P2 (P2 has linear adapter), `project_id=P2`, `track_id` belongs to P1 | 404 |
| LNSY-13 | kt_sync_to_linear | Negative | linear adapter configured with credential | Successful sync call (LNSY-01) | Success response contains no credential |

---

## 17. Dependency-Cycle Tests

See Convention #6 for how these are constructed/verified where the black-box
API alone makes an exact scenario hard to force.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| CYC-01 | kt_create_track | Negative | None | Attempt to create a track whose `depends_on` includes its own (about-to-be-assigned) ID — direct self-dependency | 409; no track created; if unreachable via the public tool surface given the deployment's ID scheme, verified instead at the dependency-validation unit level per Convention #6 |
| CYC-02 | kt_create_item | Negative | Track exists | Attempt to create an item whose `depends_on` includes its own about-to-be-assigned ID | 409; no item created (same fallback-verification note as CYC-01) |
| CYC-03 | kt_create_track | Negative | Tracks A and B exist such that A already depends on B (A created after B, `depends_on=[B]`) | Attempt an operation that would make B depend on A, closing a 2-node cycle A→B→A | 409; no new edge/record persisted; A's and B's existing dependency data unchanged |
| CYC-04 | kt_create_item | Negative | Items X and Y exist such that Y already depends on X | Attempt an operation that would make X depend on Y, closing a 2-node cycle | 409; no new edge persisted |
| CYC-05 | kt_create_track | Negative | Tracks A, B, C exist such that A depends on B, and B depends on C (chain A→B→C) | Attempt an operation that would make C depend on A, closing the 3-node transitive cycle A→B→C→A | 409; no new edge persisted; the existing A→B→C chain remains intact and unaffected |
| CYC-06 | kt_create_item | Negative | Items P, Q, R exist in a chain P→Q→R | Attempt to close R→P, forming a 3-node transitive cycle | 409; no new edge persisted |
| CYC-07 | kt_create_track (concurrency variant) | Negative | Two tracks are about to be created, each intending to depend on the other's soon-to-exist ID (e.g. both IDs pre-allocated/known to the test harness) | Fire both `kt_create_track` calls concurrently, each with `depends_on=[the other's ID]` | At most one of the two succeeds (creating a valid one-directional edge to an existing track); the other is rejected with 409, OR both are rejected with 409 if neither ID existed yet at the other's validation time — in no case do both succeed and leave a 2-node cycle in the DB |
| CYC-08 | kt_create_item (concurrency variant) | Negative | Two items about to be created, mirroring CYC-07 at the item level, same track | Fire both `kt_create_item` calls concurrently with mutual `depends_on` | Same guarantee as CYC-07: never both succeed into a stored cycle |
| CYC-09 | kt_get_track | Positive (regression guard) | A legitimate long dependency chain exists (5+ tracks, strictly acyclic) | `kt_get_track` on the last track in the chain | 200; full chain returned correctly — confirms cycle rejection logic hasn't become over-aggressive and started rejecting valid deep chains |

---

## 18. Concurrency Tests

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| CONC-01 | kt_record_session_summary | Positive (race) | Track T exists with items | Two `kt_record_session_summary` calls fired simultaneously against the same `track_id`, each with distinct `summary_text`/`files_touched`/`items_touched` | Both calls succeed; exactly two distinct `event_id`s are returned (not one reused, not a duplicate); the event log for T contains exactly 2 new entries, not 0, 1, or 3+ |
| CONC-02 | kt_record_session_summary | Positive (race) | Same as CONC-01 | Same concurrent calls | Any shared derived state each summary touches (e.g. a running `sequence_position` counter on the track, if session summaries affect one) ends in a valid, non-corrupted state — no duplicate position assigned to two different records, no gap introduced, no lost update where one call's effect silently overwrites the other's |
| CONC-03 | kt_create_item | Positive (race) | Track T exists with 3 items at positions 1–3 | Two `kt_create_item` calls fired concurrently, both omitting `sequence_position` (auto-append) | Both items are created; final positions are unique and sequential (e.g. 4 and 5, in either order) — never both landing on 4, never a gap at 4 |
| CONC-04 | kt_update_item_status | Positive (race) | Item exists, `status=pending` | Two concurrent `kt_update_item_status` calls on the same item with different target statuses (`in_progress` and `blocked`) | Both calls return `{ok:true}`; the item ends in exactly one of the two statuses (last-write-wins or documented conflict policy) — never a corrupted/undefined status, never silently ignoring both |
| CONC-05 | kt_check_drift | Positive (race) | A drift condition is active | Two concurrent `kt_check_drift` calls | Both return the same flag set; no duplicate flags are created as a side effect of concurrent checking |
| CONC-06 | kt_record_session_summary + kt_update_item_status | Positive (race, cross-tool) | Item X is item Y's dependency, X is `pending` | Concurrently: call A marks X `done` via `kt_update_item_status`; call B runs `kt_record_session_summary(items_touched=[Y])` | The drift flag for Y depends on the actual commit order (X-done-before-summary → no flag; summary-before-X-done → flag raised); whichever order wins, the result is internally consistent — no flag is raised AND the dependency shown as done simultaneously in a way that contradicts `kt_get_track`'s own state |
| CONC-07 | kt_render_roadmap | Positive (race) | Roadmap is being rendered while a concurrent `kt_create_item` commits | Concurrent `kt_render_roadmap` and `kt_create_item` calls | `kt_render_roadmap` returns a roadmap that reflects either the pre- or post-create state cleanly (a consistent snapshot) — never a torn/partial read (e.g. an item listed without its track, or a track total count that doesn't match its listed items) |

---

## 19. Adapter Tests

Covers the two sync tools' error handling plus the credential-leakage sweep
that applies across all 14 tools.

| Test ID | Tool/Area | Type | Preconditions | Input | Expected Result |
|---|---|---|---|---|---|
| ADAPT-01 | kt_sync_to_github | Negative | No github adapter configured | Call `kt_sync_to_github` | `{ok:false, error:"..."}`, HTTP 200 at the transport level (tool-level failure, not transport failure) or a documented 4xx — but never a 500/unhandled exception (duplicate of GHSY-02, listed here for the adapter-section completeness the task calls for) |
| ADAPT-02 | kt_sync_to_linear | Negative | No linear adapter configured | Call `kt_sync_to_linear` | `{ok:false, error:"..."}`, clean (duplicate of LNSY-02) |
| ADAPT-03 | kt_sync_to_github | Negative | Neither adapter configured at all | Call `kt_sync_to_github` | `{ok:false, error:"..."}` — same clean failure even in the "no adapters of any kind" case, not a different/worse error path |
| ADAPT-04 | kt_sync_to_linear | Negative | Neither adapter configured at all | Call `kt_sync_to_linear` | `{ok:false, error:"..."}` clean |
| ADAPT-05 | **All 14 tools** | Negative (credential-leakage sweep) | Project registered with `adapters={github:{token:"ghp_SECRETVALUE..."}, linear:{token:"lin_SECRETVALUE..."}}` | Run one representative successful call to each of the 14 tools against this project (register, get_status, list_tracks, get_track, get_next_steps, create_track, create_item, record_session_summary, record_decision, update_item_status, check_drift, render_roadmap, sync_to_github, sync_to_linear) | For every single response body, the raw JSON contains neither `ghp_SECRETVALUE...` nor `lin_SECRETVALUE...` nor any ≥8-character substring of either, in any field including nested objects, error messages, and echoed `source_ref`/`adapters` structures |
| ADAPT-06 | kt_get_project_status | Negative (credential-leakage, error path) | Adapter credential configured; then trigger an internal error path if one exists (e.g. malformed downstream state) | Call that surfaces an error | Even error responses/stack traces (if any are exposed) contain no credential material |
| ADAPT-07 | kt_register_project | Negative (credential-leakage, at creation) | None | Register a project with adapter credentials | The `{project_id}` response itself contains no credential echo, not even partially masked-but-derivable (e.g. not last-4-plus-length in a way that narrows brute force meaningfully beyond what's operationally necessary) |
| ADAPT-08 | kt_sync_to_github / kt_sync_to_linear | Negative | Adapter configured for github only; caller calls `kt_sync_to_linear` | Call `kt_sync_to_linear` | `{ok:false, error:"..."}` — must not fall back to or accidentally use the github adapter, and must not error in a way that reveals whether a *different* adapter is configured beyond what's necessary |
| ADAPT-09 | kt_sync_to_github | Positive → then Negative | github adapter configured and working; sync succeeds once | Immediately revoke/invalidate the credential at the remote end, then call `kt_sync_to_github` again | Second call returns `{ok:false, error:"..."}` cleanly; does not crash, does not return a stale cached `{ok:true}` |

---

## Coverage Checklist

For traceability against the task brief:

- [x] Every tool: happy path, missing/invalid field, missing/invalid auth, nonexistent-reference 404, cross-tenant-reference 404 (§2–§16, with the §2 note on `kt_register_project`'s inapplicable rows)
- [x] Cross-cutting auth matrix: valid, missing, malformed, expired, revoked, wrong-project-scope, wrong-issuer (§1)
- [x] Dependency cycles: direct self, 2-node, 3-node, both tracks and items, plus concurrent-race variants (§17)
- [x] Concurrency: dual `kt_record_session_summary` on same track — no corrupted `sequence_position`, no double-counted event (§18, CONC-01/02), plus additional concurrency surfaces
- [x] Drift detection: undone-dependency flag, unmapped-file flag, no-flag-on-clean-work, resolved-flag-doesn't-reappear-unless-recurring (§13)
- [x] `kt_get_next_steps`: unblocked-only, empty-when-all-blocked-or-done, explicit never-writes negative test (§12)
- [x] `kt_render_roadmap`: reflects current DB state exactly, twice-with-no-changes byte-identical, explicit zero-writes negative test (§14)
- [x] Adapters: no-adapter-configured clean error (not crash) for both sync tools, credential-never-in-response swept across all 14 tools (§15, §16, §19)
