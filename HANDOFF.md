> **SESSION HANDSHAKE — resume file.** You are a fresh AI session with no memory of prior
> work on this project. This file is your complete briefing. Read it fully, then confirm
> you are ready and state your intended first action before doing anything else.
> Rules: (1) Do not re-open decisions in "Decisions Made" — they are settled.
> (2) Do not touch anything in "Do Not Touch" unless the user explicitly asks.
> (3) Ground truth is the actual project state (files, running system), not this document —
> if they disagree, the real state wins and you flag the discrepancy.
> (4) `frontier_gate.py` is reachable via `device_bash` and confirmed working (`doctor`
>     verdict OK, checked 2026-09-18) — an earlier draft of this file wrongly claimed it was
>     unreachable; that was a checking error, not a real gap (see Gotchas). Run
>     `device_bash: python3 $HOME/mnt/ENV/frontier_gate.py handoff-resume HANDOFF.md
>     <real-state.txt> [HANDOFF-archive-*.md]` and put every line of `first_message_should_flag`
>     in your first message.

## Mission

KnoTrack is a self-hosted MCP server that gives an AI coding agent (and its human) a shared,
durable view of project status, sequencing, and drift — explicitly not an orchestrator, never
dispatches work. It's being built in 8 Tracks (`docs/ROADMAP.md`), and once it exists it will
dogfood itself (register itself as a KnoTrack project and track its own remaining build).
Current job: keep moving through the roadmap — T1–T4 are done/stable, T5 (GitHub + Linear
adapters) is the next real feature track.

## Current State

- **Repo:** `SathiaAI/KnoTrack` on GitHub. Sandbox working copy at
  `/home/claude/knotrack-work/KnoTrack`, `main` synced to `origin/main` at commit
  **`db3a4ef`** (verified via `git ls-remote` and local `git log` matching) — this is PR #21's
  merge commit.
- **Just shipped and merged (this session, 2026-09-18):** PR #21 — fixed a bug in
  `kt_render_roadmap` (`src/mcp/tools/render-roadmap.ts`) where a track dropped mid-render
  (time-budget break or canceled per-track query) could still move the rendered
  `_Generated` timestamp forward. Reviewed clean by both bots (Codex: 0 findings; CodeRabbit:
  "no actionable comments", one "LGTM!" landing on the exact changed lines), CI green, no new
  test added (deliberate — see Decisions Made). Full writeup:
  `claude/knotrack-pr21-roadmap-timestamp-fold-fix.md` (project doc).
- **All 245 tests pass** as of `db3a4ef` (`npm test`, 33 files) — verified in-session against a
  local scratch Postgres (see Gotchas — the test DB needs manual bring-up in this sandbox).
  `npm run typecheck` / `npm run lint` / `npm run format:check` all clean.
- **Track status, verified against real code/schema this session (ROADMAP.md's own headers
  are known to drift — see Gotchas):**
  - `T1` (spec sign-off) — informally superseded, not formally closed (`docs/SIGNOFF.md`
    doesn't exist). Long-standing, low-priority, not blocking anything real.
  - `T2` (core MCP server) — substantially complete. **One small, cheap, explicitly-tracked
    gap still open:** `kt_check_drift`, `kt_sync_to_github`, `kt_sync_to_linear` all return a
    generic `500 INTERNAL_ERROR` (`notImplementedResult` in `src/mcp/tools/stubs.ts`) instead
    of each one's bespoke stub message (`kt_check_drift` wants an empty result + "no
    heuristics configured"; the two sync tools want "adapter not configured" after validating
    the item exists). No dependencies — pick this off any time.
  - `T3` (deploy + auth) — **done** (2026-09-05, live on Railway).
  - `T4` (second-client verification) — **done** (2026-09-07).
  - `T5` (GitHub + Linear adapters) — **ROADMAP.md's own header still says `blocked`, but
    this is stale**: its stated dependencies (`T4`, `T2.16`) are both actually done. This is
    the real next Track. Sub-item state, verified against code just now:
    - `T5.1` (credential encryption at rest) — **appears already substantially/fully done**:
      `adapters.encrypted_credential bytea NOT NULL` exists (`migrations/001_init.sql`), a
      `key_version` column for rotation exists (`migrations/004_adapters_key_version.sql`),
      `src/crypto/credential-cipher.ts` implements the cipher with unit tests
      (`tests/unit/credential-cipher.test.ts`), and `scripts/rotate-encryption-key.ts` +
      `npm run rotate-encryption-key` both exist and are tested
      (`tests/unit/rotate-encryption-key.test.ts`, `tests/integration/rotate-encryption-key.test.ts`).
      **Not yet verified: whether this fully satisfies T5.1's exact stated acceptance
      criterion** (AES-256-GCM envelope encryption + a test confirming stored bytes are
      ciphertext with correct round-trip) — read `src/crypto/credential-cipher.ts` and its
      test directly before declaring T5.1 done and updating ROADMAP.md's status line.
    - `T5.2` (`kt_sync_to_github`) / `T5.3` (`kt_sync_to_linear`) — **genuinely not started.**
      Both are pure stubs today (`notImplementedResult`). No GitHub or Linear API client
      library is in `package.json` yet (checked: no `octokit`, no `@linear/sdk` or similar).
      This is the real next chunk of feature work.
    - `T5.4` (credential revocation path) — depends on T5.2/T5.3, not started.
  - `T6`/`T7`/`T8` — genuinely blocked (depend on T5, or on T6/T7 in turn).
- **The "5 deferred PR-review findings"** (from `claude/knotrack-adversarial-review-status.md`,
  sequencing decided by Paul 2026-09-07) — checked against real state this session:
  1. Spec drift (PRD/ARCHITECTURE/DATABASE_SCHEMA/TEST_CASES/README) — **resolved**
     2026-09-07, a large field-by-field reconciliation (12 of 14 tool sections had drift, all
     fixed) — see `docs/ROADMAP.md`'s own backlog note.
  2. No track-unblock write path — **resolved** by `T2.16` (shipped): track status is now
     derived at read time from the `track_readiness` view
     (`migrations/006_derived_track_status.sql`), so a track flips `blocked`→`on_track`
     automatically once its dependency is `done` — no explicit "unblock" tool was ever needed
     once status stopped being a stored column. **Not yet explicitly closed out in the
     backlog doc** — worth a one-line confirmation note there.
  3. Missing key-rotation script — **resolved**, bundled into T5.1 (see above).
  4. `@modelcontextprotocol/sdk` v1→v2 migration — **still deferred**, correctly. Still on
     `^1.17.0`. Revisit only if `T7.1`/`T7.2` (untested deploy paths) actually need
     `server/discover`; no forcing function yet.
  5. No migration rollback (`down`) support — **still genuinely open**, re-sequenced to
     `T7.7` (release-prep track, not due yet). `scripts/migrate.ts` only handles migration
     001's own hand-paired `.down.sql` file; there's no general runner-level `migrate down`
     command despite `docs/ROADMAP.md` documenting one will exist. Correctly not due until T7.
- **Housekeeping, not urgent:** several remote branches (`ci/roadmap-drift-gate-and-docs`,
  `docs/t3-6-railway-runbook`, `feature/backlog-sweep-t9x`, `feature/encryption-key-rotation`,
  `feature/sync-drift-schema`, `feature/t2-decisions-item-status`, `feature/t2-list-get-tracks`,
  `feature/t2-next-steps-roadmap`, `feature/t3-1-railway-ssl-ca-pinning`,
  `fix/t3-7-t3-8-schema-guard-and-pre-deploy-migration`,
  `hotfix/wire-record-decision-update-item-status`, `release/dogfood-v1-fixes`,
  `docs/trd-roadmap-accuracy-audit`, `docs/trd-schema-drift-fixes`) are all already merged
  into `main` but never deleted on GitHub. Cosmetic; safe to delete or ignore.
- **Exact next action:** pick one of two independent, well-scoped starting points —
  (a) the T2 stub-message gap (small, no dependencies, ~1 file), or
  (b) verify T5.1's exact acceptance criterion against `credential-cipher.ts`, correct
  `docs/ROADMAP.md`'s stale `T5`/`T5.1` status lines, then start `T5.2`
  (`kt_sync_to_github`) — the real next feature, needs a GitHub API client dependency and a
  decision on which real test repo to verify against (ask Paul).
  Recommend (b) first since it unblocks the actual roadmap track, but confirm with Paul which
  he wants first — he has not stated a preference yet this session.

## Decisions Made (and Why)

- **PR #21's fix ships with no new test.** Chose: pure code reordering (move the
  `_Generated`-timestamp fold to after the loop's only two break points), verified by
  inspection + all 245 existing tests passing. Rejected: adding a mocked-clock or
  artificial-delay test for the timing-dependent break paths. Reason: `render-roadmap.ts`'s
  own top-of-file comment and `tests/unit/render-roadmap-timeout.test.ts` already establish a
  deliberate, previously-reviewed repo convention that these exact paths are "reasoned about"
  rather than integration-tested — only the pure `isQueryCanceled` classifier gets a unit
  test. Flagged this reasoning explicitly in the PR body so the bots/Paul could push back;
  neither did. **Reversible**, but changing it means also revisiting that established
  convention, not just this one PR — raise with Paul first if a future session wants to add
  timing tests here.
- **The 5 deferred PR-review findings' sequencing** (Paul, 2026-09-07, recorded in
  `claude/knotrack-adversarial-review-status.md`): spec drift and the track-unblock path were
  queued *ahead* of any T5 code (both now done, via a doc reconciliation pass and via T2.16
  respectively); the key-rotation script was bundled into T5.1 rather than built standalone
  (now done); migration rollback was pushed to `T7.7` / release-prep rather than built
  speculatively (still pending, correctly not due yet); the SDK v1→v2 migration stays deferred
  indefinitely with no forcing function (still deferred, correctly). **Load-bearing** — this
  is Paul's own explicit sequencing call, don't re-litigate it without asking him again.
- **PR review process for every new PR**: the `pr-review-loop` skill's hard rules are in
  force — never resolve threads or merge/approve/close PRs (Paul does both), only act on
  `coderabbitai[bot]`/`chatgpt-codex-connector[bot]` comments, evaluate before fixing (a
  generic non-blocking pre-merge check like a docstring-coverage warning that isn't a real
  `reviewThreads` finding and isn't tied to the actual diff is not something to opportunistically
  fix), bounded to 4 rounds. **Load-bearing**, not this session's call to change.
- **Sandbox has zero git push credentials for this repo.** All pushes go through a
  Windows-machine relay: `git format-patch` → `SendUserFile` → `device_commit_files` to
  `F:\ENV\<name>.patch`/`.ps1` on the user's machine → a PowerShell script run via
  `Desktop_Commander__start_process` doing `git checkout -B <branch> origin/main`,
  `git am --keep-cr <patch>`, verifying `git show -s --format=%T HEAD` (**tree SHA**, not
  commit SHA — `git am` reconstructs the commit object with different metadata) matches the
  sandbox's own tree SHA exactly, then `git push`. **Load-bearing, not optional** — there is
  no other way to get code onto GitHub from this sandbox.
- **`gh` CLI is not installed in the sandbox** — every `gh api`/`gh pr` call must go through
  the same Windows relay (write a `.ps1` file, stage it, run it via
  `Desktop_Commander__start_process`). **Load-bearing.**

## Architecture & Key Files

- `src/mcp/tools/render-roadmap.ts` — **modified this session** (PR #21). Renders
  `kt_render_roadmap`'s markdown/mermaid output; has its own detailed top-of-file comment
  explaining the time-budget/statement-timeout design — read it before touching this file
  again.
- `docs/ROADMAP.md` — the canonical, hand-maintained Track/Item status doc; also doubles as
  the seed data for KnoTrack dogfooding itself eventually (`T8`). **Known to drift from
  reality** — its own "Keeping this doc honest" section (near the top) documents this
  explicitly and sets the rule: verify against real code before trusting a `Status:` line.
  `T5`'s header is currently one such stale line (see Current State). Not modified this
  session — flagged, not fixed, since fixing it wasn't this session's task.
  `scripts/check-roadmap-drift.ts` (wired into CI) only checks one narrow thing (the stub-tool
  list marker matches `src/mcp/tools/stubs.ts` exactly) — it does NOT catch the kind of
  Track-level status drift described above.
  Not touched this session.
- `src/crypto/credential-cipher.ts` + `scripts/rotate-encryption-key.ts` — pre-existing,
  likely satisfy T5.1; not touched this session, need direct verification against T5.1's
  acceptance text before relying on that assessment.
  Not touched this session.
- `src/mcp/tools/stubs.ts` — the 3 still-stub tools (`kt_check_drift`, `kt_sync_to_github`,
  `kt_sync_to_linear`) live here via `notImplementedResult`. This is the T2 gap's exact
  location and also what T5.2/T5.3 will eventually replace.
  Not touched this session.
- `tests/integration/helpers.ts` — test DB connection defaults (role `knotrack_app`, db
  `knotrack_scratch`, `127.0.0.1:5432`; password is a hardcoded local-dev-only default
  literal in that file — read it there, not reproduced here). See Gotchas — the role's
  password had drifted in the sandbox's local Postgres and needed resetting this session.
  Not touched this session (only its target DB's password was reset, not the file).
- `claude/knotrack-adversarial-review-status.md` (project doc, not in the git repo) — the
  authoritative log of Paul's sequencing decisions across the whole project. Read this before
  assuming any backlog item's status.
- `claude/knotrack-pr21-roadmap-timestamp-fold-fix.md` (project doc) — full writeup of this
  session's PR #21 fix and review round. Created this session.

## Gotchas & Hard-Won Knowledge

- **The sandbox's local Postgres is not running by default and its `knotrack_app` role's
  password can drift from `tests/integration/helpers.ts`'s hardcoded default.** This session
  had to `service postgresql start` and `ALTER ROLE knotrack_app WITH PASSWORD
  'knotrack_dev_pw' LOGIN;` (plus re-grant on the `knotrack_scratch` database/schema) before
  `npm test` would connect. If tests fail with `28P01 password authentication failed`, this is
  why — not a code problem.
- **The sandbox's local git branches never track a real remote**, because they're created via
  `git checkout -B <branch> origin/main` and the sandbox never pushes directly (see Decisions
  Made). The repo's own `stop-hook-git-check.sh` will fire a **false-alarm** "N unpushed
  commits, no remote branch" warning after every local commit on every branch, every time —
  this happened 3 times total across this session and the one before it, always a false alarm.
  Diagnose it read-only: `git fetch origin <branch>` then compare `git show -s --format=%T
  HEAD` (local) against `git show -s --format=%T FETCH_HEAD` (remote) — if the **tree SHAs**
  match, the push already happened via the relay and nothing further is needed. Never
  attempt a local `git push` to "fix" this — it has no credentials and will just fail.
- **CodeRabbit's org plan caps full/auto reviews at roughly 2–3 per hour** (seen directly in a
  review's own footer text, the number itself has drifted between 2 and 3 across this
  session — don't hardcode either). A review request that seems to hang for several minutes,
  then comes back with "Review rate limited" instead of an actual review, is this — not a bug,
  not something to keep retrying immediately.
- **`frontier_gate.py` is reachable via `device_bash` whenever the Claude desktop app is
  connected with `F:\ENV` as a connected folder — confirmed working** (`doctor` verdict OK,
  ~336ms turnaround, model `typesafe/jev-1.13-20260917`, checked 2026-09-18 via the
  `check-jev` skill). **This file's own first draft wrongly claimed it was "unreachable."**
  That was a checking error, not a real gap: the check that produced that claim ran
  `find`/`ls` against the **cloud sandbox's own local filesystem** (the plain `Bash` tool),
  which of course never has `frontier_gate.py` — it lives only on Paul's Windows machine. The
  device bridge (`mcp__remote-devices__*` tools, including `device_bash`) was actually live
  and in active use for the entire session that wrote this claim — it's what pushed PR #21
  and created it. **Lesson: to check whether the Jev gate is reachable, always run
  `device_bash: python3 $HOME/mnt/ENV/frontier_gate.py doctor` directly — never infer
  unavailability from a local sandbox filesystem search** (`find`, `ls`, etc. in the plain
  `Bash` tool only ever sees the cloud container, never the connected device).
- **`handoff-lint` run against this file (2026-09-18, after the above correction) came back
  `pass: false`** — no secrets, no missing sections, but `next_action_unambiguous` (0.52),
  `resume_command_client_neutral` (0.59), and `standalone` (0.63) all scored below the 0.7
  bar. Root cause: the "Exact next action" and "Resume Command" sections both correctly end
  by requiring a live decision from Paul (which of the two starting points he wants) rather
  than being fully self-contained — honest given the real open question, not sloppiness, but
  worth a tightening pass if a future session wants a clean lint result once Paul has
  answered that question.
- **PowerShell one-liners passed inline via `-Command` with embedded `$(...)` subexpressions
  inside a double-quoted string reliably break** ("Expressions are only allowed as the first
  element of a pipeline") when relayed through the device-bridge `start_process` tool. Always
  write the PS logic to a `.ps1` file and run `-File`, never `-Command "...`long inline
  script...`"`.
- **The device-bridge `start_process` call appears to have an internal ~60s cap on returning
  initial output**, independent of the `timeout_ms` parameter passed to it — a script that
  `Start-Sleep`s for 90s before printing anything triggered "Device did not respond within
  60s" even with `timeout_ms: 120000`. Workaround: never sleep inside the remote PS script:
  use the sandbox's own `Bash` `sleep N` between polls, then invoke a fresh, immediate
  (no-sleep) PS poll script each time.

## Conventions In Play

- Commit messages: `type: imperative description`, body explains why + cites the specific
  Codex `databaseId` or CodeRabbit finding when fixing a review comment. No emoji.
- PRs: one focused round of changes per commit when responding to review; PR body always
  ends with the `Co-Authored-By`/`Claude-Session` and `🤖 Generated with Claude Code` +
  session-link attribution lines (see this session's own system reminder for the exact
  current lines — they can change between sessions, always use whatever the *current*
  session's reminder specifies, not what's hardcoded in an old PR).
- `pr-review-loop` skill hard rules are always in force for any PR this session touches:
  never resolve threads, never merge/approve/close, only act on the two named bot logins,
  evaluate-before-fix, max 4 rounds.
  Deliberately NOT doing yet: adding timing-dependent tests for `render-roadmap.ts`'s
  time-budget paths (see Decisions Made); starting T6/T7/T8 work (genuinely blocked); the
  MCP SDK v2 migration (deferred indefinitely).
- Every ROADMAP.md `Status:` line must be treated as possibly stale — verify against real
  code before trusting it, per the doc's own stated rule.

## Open Questions

- Does Paul want the T2 stub-message gap (kt_check_drift/kt_sync_to_github/kt_sync_to_linear
  bespoke error messages) done first as a quick win, or go straight to verifying/starting T5?
- For T5.2 (`kt_sync_to_github`): which real GitHub repo should be used to verify the
  create/update-Issue round trip, and is there already a GitHub App/PAT Paul wants used, or
  should a new one be created? (T5.1's encryption-at-rest work needs a real credential to
  actually encrypt once this starts.)
- For T5.3 (`kt_sync_to_linear`): same question — which real Linear workspace/API key.
- Should `docs/ROADMAP.md`'s stale `T5` (and possibly `T5.1`) status headers be corrected in
  their own small housekeeping PR before T5.2 work starts, or folded into the same PR as the
  first real T5.2 commit? (The doc's own rule says "in the same PR that completes the
  criterion" — T5.1 may already be complete, which would argue for fixing it now, separately.)
- Should the already-merged, undeleted remote branches (listed under Current State) be cleaned
  up, or left alone?

## Do Not Touch

- `render-roadmap.ts`'s time-budget/statement-timeout design and its "reasoned about, not
  tested" policy for the two break paths — settled precedent across multiple PR review
  rounds (#16, #19, #21). Don't add a timing test here without raising it with Paul first.
- The 5-findings sequencing decision in `claude/knotrack-adversarial-review-status.md` —
  Paul's own explicit call (2026-09-07). Don't resequence without asking him again.
- Any already-merged PR (#14 through #21) — settled, don't reopen or re-review.
- Do not attempt a local `git push` from the sandbox to "fix" a stop-hook unpushed-commits
  warning — always verify read-only first (see Gotchas); the sandbox has no push credentials
  and a push attempt will just fail (harmlessly, but it's wasted motion and can look alarming
  in the output).

## Resume Command

Open `/home/claude/knotrack-work/KnoTrack` (or re-clone `SathiaAI/KnoTrack` and check out
`main`). Read this file fully, then run `git log --oneline -5` and `git status` to confirm
`main` is still at (or ahead of) `db3a4ef` with a clean tree. Ask Paul which of the two
"Exact next action" options (T2 stub-message gap, or verify-T5.1-then-start-T5.2) he wants
first, per the first Open Question — then proceed using the same Windows-relay push pipeline
and `pr-review-loop` process described in Decisions Made and Conventions In Play.
