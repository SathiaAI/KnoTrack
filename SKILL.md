---
name: knotrack
description: Check and update a project's tracked status (tracks, items, drift, decisions) in a self-hosted KnoTrack instance, without dispatching or orchestrating work.
---

# KnoTrack

KnoTrack is a self-hosted MCP server that gives coding agents durable,
cross-session visibility into a project's tracks, work items, decisions,
and drift. It never assigns or dispatches work — it tracks, sequences, and
reports. See `README.md` and `docs/TRD.md` in this repo for the full tool
reference and protocol details.

This file exists as a second, lower-effort discovery path for harnesses
that pick up the `SKILL.md` convention but haven't wired up KnoTrack's MCP
server directly (docs/ROADMAP.md's T9.x backlog). It does not replace the
MCP-first integration — every mutating operation (registering a project,
creating a track/item, recording a session summary or decision) still goes
through the MCP tools documented in `docs/TRD.md` §3.

## Checking project status without an MCP round-trip

`kt_get_project_status` is a deterministic read query — no LLM reasoning
involved server-side. For a quick status check from a terminal, or a CI
step, use the thin CLI wrapper instead of the MCP transport:

```bash
npm run get-project-status -- <project_id>
```

This prints the same JSON `kt_get_project_status` returns (tracks with
item counts, open drift flags, recent session-summary/decision events) —
see `scripts/get-project-status-cli.ts` and docs/TRD.md §3.3 for the exact
shape. It requires the same environment variables as the server
(`DATABASE_URL`, `KNOTRACK_ENCRYPTION_KEY`, etc. — see docs/TRD.md §7) and
talks to the database directly, not to a running server process.

## Everything else goes through MCP

For anything beyond a status read — registering a project, creating a
track or item, recording a session summary, rotating an adapter credential
— connect to KnoTrack as an MCP server and call the corresponding tool
(`docs/TRD.md` §3 documents every tool's input/output contract and error
envelope). This repo's current tool implementation status is tracked in
`README.md`'s tools table.
