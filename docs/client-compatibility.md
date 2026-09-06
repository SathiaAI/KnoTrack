# Client compatibility notes

Evidence for `T4.1`–`T4.3` in `docs/ROADMAP.md`: a second, different MCP
client, pointed at the same Railway deployment and bearer token used for
`T3.5`, with **zero server-side code or config changes**.

## Clients verified

| Client | Role | Result |
|---|---|---|
| `@modelcontextprotocol/sdk` TypeScript `Client` (Node.js) | First client (`T3.5`, 2026-09-05) | `kt_register_project`, `kt_create_track` succeeded with real payloads. |
| LM Studio 0.4.23 (MCP integration via `mcp.json`) | Second client (`T4.1`–`T4.2`, 2026-09-06) | All 6 required tools succeeded; `kt_check_drift` returned its documented stub. |

Cursor was the original candidate for the second client but was not driven
in this session for an environment-specific reason, not a client
limitation: the remote computer-use bridge classifies IDE/terminal
applications as click-only (view + click, no keystroke injection), so
Cursor's chat could not be typed into from this session. This is a
restriction of the automation tooling used to drive the test, not evidence
that Cursor can't function as an MCP client — `C:\Users\pjpou\.cursor\mcp.json`
is left in place (pointed at the same server/token) in case Paul wants to
try it by hand. LM Studio resolved to full type+click access and was used
instead.

## `T4.1` — second client configured

`C:\Users\pjpou\.lmstudio\mcp.json` gained a `knotrack` entry alongside
Paul's pre-existing `linear`/`github-*` entries, pointing at the same
`https://knotrack-server-production.up.railway.app/mcp` URL and the
bearer token in use for `T3.5` at the time (rotated once more since, per
the note below — same mechanism, not a new decision). No server-side file
changed. The integration was enabled in LM Studio's Integrations panel (new
MCP entries default to disabled) and confirmed present as a tool source in
a new chat.

## `T4.2` — full tool-call smoke test

All six required tools were called from LM Studio's chat (model:
`google/gemma-4-12b-qat`, each call reviewed and approved through LM
Studio's per-call tool-approval prompt), threading each real ID into the
next call rather than reusing fixture data:

1. `kt_register_project` (`name: "T4 LM Studio Smoke Test"`, `source_type:
   "local"`) → `{"project_id":"64cfb347-dffe-47c9-8cdf-0f88c3c8ee20"}`
2. `kt_create_track` (`title: "T4 Smoke Test Track"`) →
   `{"track_id":"fd23bbbb-a15d-4cef-8eb9-fbb55f09a1e8"}`
3. `kt_create_item` (`title: "T4 Smoke Test Item"`) →
   `{"item_id":"7130554e-06e6-4871-bbba-f26f281f2621"}`
4. `kt_update_item_status` (`status: "in_progress"`) → `{"ok":true}`
5. `kt_get_next_steps` → `{"recommended_items":[]}` — correct: the only
   item on the project is `in_progress`, not `pending`, so an empty
   recommendation list is the expected result, not a failure.
6. `kt_record_session_summary` → `{"event_id":"...","drift_flags_raised":[]}`
7. `kt_check_drift` → returned the documented stub error:
   ```json
   {"error":{"code":"INTERNAL_ERROR","http_status_equivalent":500,"message":"kt_check_drift is registered but not yet implemented in this build","details":{"tool":"kt_check_drift"}}}
   ```
   This is byte-for-byte the template in `src/mcp/tool-helpers.ts` —
   confirmed by grepping the server source, not just eyeballing it — and
   matches the same stub shape `T3.5` exercised. This satisfies `T4.2`'s
   2026-08-28-corrected acceptance: both clients are checked against the
   stub response, not a real drift answer (`T6` is not built yet).

All six succeeded with real payloads (not `isError: true`), and none
required any server-side change — `T4.1`'s "zero server changes"
condition holds for `T4.2` as well.

## Client-specific quirks observed (none required a server change)

- **Tool-schema token overhead with multiple MCP integrations enabled.**
  With `linear`, both `github-*` entries, and `knotrack` all active, and
  the originally-loaded model (`qwen/qwen3-8b-27b` — a large model on this
  hardware) configured with an 8192-token context window, LM Studio's
  first request failed client-side: `request (24678 tokens) exceeds the
  available context size (8192 tokens)`. Cause: the cumulative JSON tool
  schemas from every *active* integration are included in every request,
  not just the one tool actually being called. Fix, entirely client-side:
  disabled the unrelated `linear` integration for this chat, leaving only
  `knotrack` active, which dropped the request to ~2,600 tokens. An
  equally valid fix would be loading the model with a larger context
  window. Anyone reproducing this should either keep few integrations
  active per chat or size the context window to the number enabled.
- **Reasoning-heavy models are impractically slow on this hardware.** The
  originally-loaded `qwen/qwen3-8b-27b` at "Extra High" reasoning effort
  took over 2 minutes to produce a single short reasoning fragment before
  being manually stopped — apparently CPU-bound, with no GPU offload
  configured for that model on this machine. Switching to a smaller model
  (`google/gemma-4-12b-qat`, ~7 GB loaded) made each tool call resolve in
  1–3 seconds end to end. This is a local hardware/model-sizing
  observation, not an MCP-protocol or server issue — any tool-calling
  model would exercise the same server code path.
- **Per-call human approval by default.** Unlike the raw SDK client used
  for `T3.5`, LM Studio's UI prompts for explicit approval
  (Proceed/Deny/Deny with reason) before executing each MCP tool call,
  with an optional "always allow this tool" checkbox. This is a client UX
  choice, not a protocol difference — it does not change the request/response
  shape the server sees.
- **New MCP entries default to disabled.** Adding `knotrack` to
  `mcp.json` was not enough by itself; it had to be toggled on in LM
  Studio's Integrations panel before it appeared as a callable tool source
  in chat.

None of the above required, or led to, any change in `SathiaAI/KnoTrack`
server code, `railway.json`, environment variables beyond the routine
bearer-token rotation already covered under `T3.5`/`T3.6`, or the MCP
protocol surface itself. `T4.1`'s "zero server-side code or config
changes" condition holds.
