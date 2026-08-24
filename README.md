# KnoTrack

A project manager for your projects — not an orchestrator.

KnoTrack steps into an existing software project, reads its source-of-truth
documents, reports current status, helps sequence upcoming work against
declared dependencies, and detects drift (work happening that isn't
reflected in the plan, or happening out of sequence). It never assigns or
dispatches work — it tracks, sequences, and reports. If your project
already has an orchestrator, KnoTrack supports it rather than replacing it.

It speaks [MCP](https://modelcontextprotocol.io) (the 2026-07-28, stateless
revision of the spec), so it works the same way from Claude Code/Cowork,
Windsurf, Codex CLI, LM Studio, Goose, Hermes, or any other MCP-speaking
harness — not just one vendor's tool.

## Status

Pre-release, v0.1.0. 5 of the 14 planned tools are implemented and
dogfooded (KnoTrack tracks its own build using itself — see
[`scripts/seed-self.ts`](scripts/seed-self.ts) and `docs/ROADMAP.md`'s T1);
the remaining 9 are registered with their real, TRD-accurate input schemas
so `tools/list` already reflects the full surface, but each currently
returns a clear "not yet implemented" error rather than doing partial work.

Every change lands through a mandatory adversarial-review gate before it's
considered reviewed: deterministic checks (build, lint, typecheck, unit,
integration, secrets scan, dependency audit, SAST, IaC scan, migration
lint, mutation testing) plus an independent panel of reviewer models from
providers uninvolved in writing the code, with a verdict computed by
script — never self-assessed. The latest full run's verdict is **PASS**
(13/13 gates, 5 independent reviewers, 3 high/critical findings all
confirmed and fixed with regression tests, 11 lower-severity findings
triaged and tracked as backlog). Review run artifacts are kept locally
(`.adversarial-review/`, gitignored) rather than committed, since they can
include full diffs and raw model output.

## Tools

| Tool | Status | Purpose |
| --- | --- | --- |
| `kt_register_project` | implemented | Register (or upsert) a project by its source (`github`, `local`, etc.) |
| `kt_get_project_status` | implemented | Current status summary: tracks, items, drift flags |
| `kt_create_track` | implemented | Create a track (a sequenced line of work) under a project |
| `kt_create_item` | implemented | Create an item within a track, auto- or explicitly-sequenced |
| `kt_record_session_summary` | implemented | Record a session's summary and re-check for drift |
| `kt_list_tracks` | planned | List a project's tracks, optionally filtered by status |
| `kt_get_track` | planned | Track detail: items plus dependency graph |
| `kt_get_next_steps` | planned | Suggested next items given current status and dependencies |
| `kt_record_decision` | planned | Record a decision and the context behind it |
| `kt_update_item_status` | planned | Move an item's status forward (or flag it blocked) |
| `kt_check_drift` | planned | On-demand drift scan across a project |
| `kt_render_roadmap` | planned | Render a roadmap view from tracked items |
| `kt_sync_to_github` | planned | One-way sync of tracked items to GitHub Issues |
| `kt_sync_to_linear` | planned | One-way sync of tracked items to Linear |

Full request/response contracts for every tool, implemented or planned,
are in [`docs/TRD.md`](docs/TRD.md).

## Quick start

Requirements: Node.js 20.12+, a Postgres database.

```bash
git clone https://github.com/SathiaAI/KnoTrack.git
cd KnoTrack
npm install

cp .env.example .env
# edit .env: set DATABASE_URL, then generate the other two required values
npm run generate-token   # -> KNOTRACK_API_TOKENS
openssl rand -base64 32  # -> KNOTRACK_ENCRYPTION_KEY

npm run migrate
npm run dev               # starts the MCP server (stateless HTTP, see docs/TRD.md §3)
```

Point any MCP-speaking client at `http://localhost:8080/mcp` with the
bearer token you generated. `GET /health` is intentionally unauthenticated
and checks DB connectivity from its own isolated connection pool, so it
stays truthful even when the main pool is under load.

To see KnoTrack track its own build (the "dogfood" step referenced in
`docs/ROADMAP.md`'s T1), run `npm run seed-self` after migrating.

## Configuration

Every environment variable, required and optional, is documented inline in
[`.env.example`](.env.example) and in full in
[`docs/TRD.md`](docs/TRD.md) §7 — connection pooling, statement timeouts,
drift-scan caps, roadmap caps, and the TLS/encryption settings.

## Development

```bash
npm test              # unit + integration (vitest)
npm run test:mutation # mutation testing (stryker) — see stryker.conf.json
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run format          # prettier --write
```

Integration tests need a reachable Postgres matching `DATABASE_URL`;
`tests/integration/helpers.ts` truncates between tests rather than
recreating the schema.

## Documentation

- [`docs/PRD.md`](docs/PRD.md) — product requirements
- [`docs/TRD.md`](docs/TRD.md) — technical requirements, full tool contracts
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — solution design, diagrams
- [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) — schema + ERD
- [`docs/TEST_CASES.md`](docs/TEST_CASES.md) — positive/negative test matrix
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased build plan

## Self-hosting

KnoTrack is self-hosted — you run your own instance against your own
database; there is no central KnoTrack service. A [`Dockerfile`](Dockerfile)
is included for containerized deployment; wire it to whatever Postgres and
scheduler your infrastructure already uses (Render+Supabase, Railway,
Fly.io, or your own hosts all work — KnoTrack itself has no
infrastructure-specific dependencies beyond Postgres and a Node runtime).

## License and attribution

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

This is genuinely open source: you can fork it, modify it, and run it
commercially. What the license asks in return (Apache-2.0 §4(d)) is that
the attribution notices in `NOTICE` remain available to anyone you
redistribute to — that's what keeps credit attached to the project as it
spreads. You're free to extend `NOTICE` with your own notices; it doesn't
have to stay byte-for-byte unmodified, and adding to it doesn't change the
license terms. If you build something publicly on top of KnoTrack, a
visible mention ("built on KnoTrack") is appreciated but not legally
required beyond keeping those notices available; please don't strip
attribution and present it as an unrelated original work.
