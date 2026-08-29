# Verification runbook — Render+Supabase, Fly.io, Grok, Perplexity

**Status:** Runbook for work Paul is running personally. Closes out
`docs/ROADMAP.md`'s `T7.1`, `T7.2`, and `T4.4` — all three currently
"claimed in the PRD, never verified." Nothing here should be marked
done until it's actually been run against a live deployment/client; this
document is the plan, not the record. Record actual results in
`docs/client-compatibility.md` (client tests) and by updating this file's
own "Result" fields (deploy tests) once run.

Every section below assumes the same starting point: the KnoTrack repo at
the commit already verified on Railway, `KNOTRACK_ENCRYPTION_KEY` and a
`KNOTRACK_API_TOKENS` value generated fresh per deploy target (don't reuse
the Railway token — if a target turns out to be misconfigured, you don't
want it holding a credential valid elsewhere), and `npm run build`
producing a clean `dist/`.

---

## Part A — Render + Supabase (`T7.1`)

**What "pass" means (from `T7.1`'s acceptance criterion):** the same
commit deployed to Render with Supabase Postgres, health-check returns
`200`, and one real MCP client successfully calls `kt_register_project`.

**Known platform-specific facts already in `docs/TRD.md` §7 — read before
starting, don't rediscover these live:**
- Render's **free tier has no persistent local disk** — irrelevant here
  since Postgres lives on Supabase, not on Render, but confirms why
  Postgres-only was mandated project-wide (§1).
- Free-tier Render instances **spin down on idle**; the first request
  after a cold start may blow past the TRD's normal latency budgets —
  that's an accepted, documented exception, not a bug you need to chase.
- Migrations run via Render's **pre-deploy command**, not the app's
  start command or request path — this matters, because if you instead
  run `npm run migrate && npm start` as the *start* command (the Railway
  pattern), you'd re-run migrations on every restart instead of once per
  deploy.
- `PORT` **must** come from the environment — Render injects its own and
  routes traffic to it. The app already reads `process.env.PORT`
  (confirmed in `src/config/env.ts`); nothing to change here, just don't
  override it.
- `DATABASE_SSL_MODE` should be `require` — Supabase's public connection
  string requires TLS. Supabase ships `pgcrypto` by default, consistent
  with the TRD's credential-encryption design; no extension setup needed.
- `KNOTRACK_DB_SSL_CA_BASE64` is explicitly **not needed** for Supabase
  (TRD §7) — that variable exists for Railway's self-signed cert
  specifically. Leave it unset.

**Steps:**

1. **Supabase:** create a new Supabase project (any region). `DATABASE_URL`
   needs a connection that is both session-level (holds a
   `pg_advisory_lock` across multiple statements — see below) and reachable
   from Render's network. Those two requirements rule out two of
   Supabase's three connection strings, which is why the pick below isn't
   the "direct" one you might reach for first:
   - **Do not** use the Supavisor **transaction-mode** connection string
     (port `6543`): `scripts/migrate.ts` takes a session-level
     `pg_advisory_lock` and holds it across multiple statements
     (`scripts/migrate.ts`'s `applyMigrations`), and under transaction
     pooling those statements can land on different backend sessions — the
     lock can be ineffective, leak on a pooled backend, or block a later
     deploy (adversarial PR review finding).
   - **Do not** use Supabase's plain **direct** connection string either,
     despite it being session-level: that endpoint is IPv6-only, and
     Render's outbound network is IPv4-only by default (shared IPv4) —
     Render simply cannot reach it, so the migration step would fail to
     connect regardless of the advisory-lock question (CodeRabbit
     follow-up review finding on this file's first fix pass; confirmed
     against Supabase's and Render's own networking docs).
   - **Use Supavisor's Session mode instead, on port `5432`**
     (Project Settings → Database → Connection string → pick "Session
     mode," not "Transaction mode"). Session mode is dual-stack
     (IPv4-reachable from Render) and session-level (safe for
     `pg_advisory_lock`), so it satisfies both constraints at once. Use
     this same string for `DATABASE_URL` as a whole — the app's own
     runtime pool (`src/db/pool.ts`) has no conflicting requirement, so
     there's no reason to run a different connection string for the app
     than for the migration step.
   - If a true direct connection is ever required for some other reason,
     Supabase's paid IPv4 add-on makes the direct endpoint reachable from
     an IPv4-only network like Render's — not needed for this runbook, but
     the fallback if Session mode turns out to be insufficient.
2. **Render:** create a new Web Service on a **paid** plan — Render's
   Pre-Deploy Command (used below) is not available on the Free tier
   (adversarial PR review finding; confirmed against Render's own
   deploy-lifecycle docs). Connect the KnoTrack GitHub repo, and in the
   service Settings page, set:
   - **Build Command:** `npm ci && npm run build` — `npm run build` now
     copies `migrations/` into `dist/migrations` itself (guarded so it's
     a no-op inside the Docker build, where that directory isn't
     present at build time and is copied separately — see the
     Dockerfile), so nothing extra is needed here; without that fix, a
     source-based build like this one would produce a `dist/` with no
     migrations directory at all, and the Pre-Deploy Command below would
     fail with `ENOENT` (adversarial PR review finding).
   - **Pre-Deploy Command:** `node dist/scripts/migrate.js`
   - **Start Command:** `node dist/src/index.js` (no migration wrapper —
     the pre-deploy command already ran it, exactly once, before this
     starts)
   - **Health Check Path:** `/health`
   (Render's dashboard field names are confirmed current as of this
   writing; if you're scripting this as a `render.yaml` blueprint
   instead of clicking through the dashboard, cross-check the exact YAML
   keys against Render's own Blueprint spec reference — not reproduced
   here since it wasn't independently verified this pass.)
3. Set environment variables: `DATABASE_URL` (from step 1),
   `KNOTRACK_API_TOKENS` (a freshly generated token —
   `node dist/scripts/generate-token.js` locally, or `tsx
   scripts/generate-token.ts`), `KNOTRACK_ENCRYPTION_KEY` (32
   random bytes, base64), `NODE_ENV=production`,
   `DATABASE_SSL_MODE=require`.
4. Deploy. Watch the build + pre-deploy logs for a clean migration run
   (same output shape as the Railway deploy — a list of applied
   migration filenames, no errors).
5. Once live, `curl https://<your-render-url>/health` — expect
   `200 {"status":"ok",...,"db":"ok"}`.
6. Point one real MCP client (reuse whichever you used for the Railway
   T3.5 check — same config shape, new URL and token) at
   `https://<your-render-url>/mcp` and call `kt_register_project`.

**Result:** _(fill in once run — date, Render URL, pass/fail, any
deviation from the steps above)_

---

## Part B — Fly.io (`T7.2`)

**What "pass" means:** same codebase deployed to Fly.io, health-check
`200`, one real MCP client calls `kt_register_project` successfully.

**Known platform-specific facts (TRD §7) — the one genuinely easy
mistake to make here:**
- Fly Postgres over its **private `6PN` network** (the normal,
  recommended path) does **not** present a TLS certificate at all.
  `DATABASE_SSL_MODE` must be `disable` for that configuration — setting
  it to `require` here will fail every connection, not silently
  downgrade. Only use `require` if you deliberately connect over Fly's
  public Postgres proxy instead of the private network.
- Migrations run via `fly.toml`'s **`release_command`** — a one-off task
  Fly runs once before any new Machine takes traffic, the same
  "exactly-once, before the app starts" shape as Render's pre-deploy
  command and Railway's `startCommand` wrapper, just a different
  mechanism per platform.
- `KNOTRACK_DB_SSL_CA_BASE64`: not needed here either — that's a
  Railway-specific quirk (TRD §7).

**Steps (flyctl commands verified against Fly's current docs as of this
writing — [Create a Fly Postgres Cluster](https://fly.io/docs/postgres/getting-started/create-pg-cluster/), [Attach/Detach](https://fly.io/docs/postgres/managing/attach-detach/), [fly.toml reference](https://fly.io/docs/reference/configuration/)):**

1. `fly postgres create` — creates a standalone Postgres cluster (any
   name/region). Note: this does not generate a `fly.toml`, so reference
   it by name (`-a <postgres-app-name>`) in later commands if needed.
2. `fly launch --no-deploy` from the KnoTrack repo root to scaffold the
   app's `fly.toml` (or hand-write one — the app doesn't need anything
   Fly-specific beyond what's below). `--no-deploy` matters here: without
   it, `fly launch` deploys immediately after creating the app, before
   the database is attached, secrets are set, or `release_command` is
   added below — an avoidable failed first deployment (adversarial PR
   review finding). The real first deploy is step 6.
3. In `fly.toml`, add:
   ```toml
   [deploy]
     release_command = "node dist/scripts/migrate.js"

   [[http_service.checks]]
     grace_period = "10s"
     interval = "30s"
     method = "GET"
     timeout = "5s"
     path = "/health"
   ```
4. `fly postgres attach <postgres-app-name> --app <knotrack-app-name> --superuser=false`
   — this sets `DATABASE_URL` on the app automatically; you don't set it
   by hand. `--superuser=false` matters: the flag defaults to `true`,
   which would otherwise grant the app's database user full superuser
   privileges it has no need for (adversarial PR review finding — least
   privilege, not "it happens to work either way").
5. Set secrets via stdin, not as command-line arguments — a
   `fly secrets set KEY=value ...` invocation would leave
   `KNOTRACK_API_TOKENS` and `KNOTRACK_ENCRYPTION_KEY` sitting in shell
   history (adversarial PR review finding). A heredoc avoids putting the
   values on the command line itself, but an interactive Bash session
   still writes the heredoc's body lines to `~/.bash_history` once the
   command completes — pause history for just this command with
   `set +o history` / `set -o history` around it (CodeRabbit follow-up
   review finding on this file's first fix pass):
   ```bash
   set +o history
   fly secrets import --app <knotrack-app-name> <<'EOF'
   KNOTRACK_API_TOKENS=<fresh token>
   KNOTRACK_ENCRYPTION_KEY=<32-byte-base64>
   NODE_ENV=production
   DATABASE_SSL_MODE=disable
   EOF
   set -o history
   ```
   (`disable` because step 4 connects over Fly's private network per the
   quirk above — confirm this is actually how `fly postgres attach`
   wired it before assuming; if it turns out to be a public connection
   string instead, use `require` and revisit).
6. `fly deploy`. Watch the release_command output for the same clean
   migration-list signature as Render/Railway.
7. `curl https://<your-app>.fly.dev/health` — expect `200`.
8. Point one real MCP client at `https://<your-app>.fly.dev/mcp` and
   call `kt_register_project`.

**Result:** _(fill in once run)_

---

## Part C — Grok custom connector (`T4.4`)

**What this is testing:** whether Grok's OAuth/API-Key-shaped
custom-connector UI can actually reach a server that only speaks a
static `Authorization: Bearer <token>` scheme — genuinely unverified,
not just untested-by-us (xAI's own docs don't specify what auth options
the UI exposes).

**Steps:**

1. Go to `grok.com/connectors` → **New Connector** → **Custom**.
2. Server URL: `https://knotrack-server-production.up.railway.app/mcp`
   (reuse the live Railway deployment — this is a client test, not
   another deploy target).
3. When prompted for authentication, try, in order, whichever of these
   the UI actually offers: (a) a raw header/API-key field — if present,
   enter `Authorization` / `Bearer <token>` or just `<token>` depending
   on how the field is labeled; (b) an "API Key" field with no header
   name control — enter the bearer token value alone and see what
   Grok actually sends (this is exactly the ambiguity flagged earlier —
   there's no way to know until it's tried); (c) if only OAuth is
   offered, this fails and that's a real, useful answer, not a dead end.
4. Once connected (if it connects), ask Grok in conversation to "use the
   knotrack connector to register this project" — watch whether it
   actually invokes `kt_register_project` and what comes back.

**Pass:** `kt_register_project` succeeds and returns a `project_id`.
**Fail (still a useful, recordable outcome):** the connector UI has no
way to express a raw bearer token, or it connects but every tool call
401s. Either way, write down exactly which auth option you picked and
what happened — that's the whole point of this test.

**Result:** _(fill in once run — record in `docs/client-compatibility.md`
either way)_

---

## Part D — Perplexity custom connector (`T4.4`)

**What this is testing:** the same question as Grok, plus resolving a
real conflict in Perplexity's own help-center docs — one article
describes a live "Custom connector → Remote" flow with an OAuth/API
Key/None dropdown; another says remote MCP is still "coming soon." Only
actually trying it resolves which is current.

**Steps:**

1. Account Settings → **Connectors** → **+ Custom connector**. If this
   option doesn't exist at all, that confirms the "coming soon" doc was
   the current one — record that and stop, this is a fail-fast, not a
   blocker to dig around.
2. If it exists: select **Remote**, name it, paste
   `https://knotrack-server-production.up.railway.app/mcp` as the MCP
   Server URL.
3. Auth method dropdown: try **API Key** first (closest fit to a bearer
   token) and enter the token value. If that field turns out to send it
   somewhere other than an `Authorization: Bearer` header — you'll be
   able to tell because every tool call will 401 — that's the answer:
   record it as "API Key option present but incompatible with a raw
   bearer scheme," not "broken."
4. Ask Perplexity to call `kt_register_project` via the connector.

**Pass:** `kt_register_project` succeeds and returns a `project_id`.
**Fail:** connector option doesn't exist, or every call 401s regardless
of how the API Key field is filled in.

**Result:** _(fill in once run — record in `docs/client-compatibility.md`
either way)_

---

## After running all four

1. Update this file's four **Result** fields with what actually
   happened — pass, fail, and exact deviations from the steps (a
   platform's docs are often behind its actual UI; note where that
   happened). This file's Result fields are the record for all four
   parts. Parts C and D's outcomes additionally belong in
   `docs/client-compatibility.md` (CodeRabbit review finding: the two
   documents' instructions previously read as conflicting about where
   client results go) — that file is the standing, cross-project ledger
   of which MCP clients work with a bearer-token server, meant to be
   consulted on its own by someone who has never run this runbook, not
   just a duplicate of Parts C/D's Result fields. Parts A and B are
   deploy-platform tests, not client-compatibility facts, so they only
   need this file's own Result field.
2. Update `docs/ROADMAP.md`: flip `T7.1`/`T7.2`/`T4.4`'s status once
   each is genuinely done, don't just check the box because the attempt
   was made — a failed Grok/Perplexity attempt still closes `T4.4` per
   its own acceptance criterion (either outcome is a real answer), but a
   failed Render or Fly deploy does **not** close `T7.1`/`T7.2`.
3. If either Render or Fly.io deploy failed for a reason that isn't
   already documented as a known quirk above, add it to `docs/TRD.md`
   §7 the same way the Railway CA-pinning and Fly private-network TLS
   quirks are documented there — that's exactly the kind of fact this
   project has committed to capturing rather than losing.
