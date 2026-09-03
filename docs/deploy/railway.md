# Railway reference-deployment runbook

**Status:** Closes `docs/ROADMAP.md`'s `T3.6`. Written 2026-09-03, after
`T3.1`–`T3.4` and `T3.7`/`T3.8` were all confirmed live on the actual
`KnoTrack` Railway project — every step below documents what was actually
done and verified, not a plan for someone else to try later. `T3.5` (a real
MCP client calling `kt_register_project`/`kt_create_track` against this
deployment) is **not** covered here — it needs a client under a human's
control and is out of scope for this runbook.

This is written for someone with zero prior context on this specific
deployment: a fresh Railway account, the KnoTrack repo checked out, and
nothing else assumed.

---

## 1. Provisioning

**Project:** `KnoTrack`, workspace `ViaKnox`, environment `production`. Two
services live in it:

| Service | Image / source | Purpose |
|---|---|---|
| `Postgres` | `ghcr.io/railwayapp-templates/postgres-ssl` | managed Postgres, self-signed TLS |
| `knotrack-server` | GitHub source, `SathiaAI/KnoTrack` `main`, built from the repo's own `Dockerfile` | the MCP server |

**To provision from scratch:**

1. Create a Railway project, add a new service from the
   `railwayapp-templates/postgres-ssl` Docker image (not Railway's default
   "Add Postgres" plugin — that one doesn't support pinning a custom CA the
   way this project needs; see §3). Attach a persistent volume mounted at
   `/var/lib/postgresql/data`. Set `POSTGRES_USER`, `POSTGRES_DB`, and a
   generated `POSTGRES_PASSWORD` (Railway can generate this — use its
   "generate value" option rather than typing a password by hand), plus
   `PGDATA=/var/lib/postgresql/data/pgdata`.
   - **Known failure mode, hit during initial setup:** the volume-attach
     step triggers Railway's own automatic redeploy of the Postgres
     service. If you set `POSTGRES_PASSWORD` via `set-variables` with
     `skipDeploys: true` (to batch it with other variables), that
     redeploy can race ahead and start the container with no password
     set yet, crashing it. Fix: once the variable is confirmed saved,
     trigger one explicit redeploy of the Postgres service before moving
     on, rather than assuming the batched variable set alone got applied
     to a running container.
2. Add a second service to the same project from GitHub, pointed at
   `SathiaAI/KnoTrack`, branch `main`. **Do not delete or edit the repo's
   `Dockerfile`** — Railway will always build from a checked-in
   `Dockerfile` when one exists, "regardless of the builder setting shown
   in the dashboard/API" (Railway's own documented behavior; confirmed
   here by reading this service's own build logs line-for-line against
   the Dockerfile — every stage matched exactly, `build.builder` reported
   `RAILPACK` the entire time regardless). Don't be misled by that field.
3. Generate a public domain for `knotrack-server` (Railway → service →
   Settings → Networking → Generate Domain). Target port must match the
   Dockerfile's `EXPOSE`/`HEALTHCHECK` — `8080` in this repo.
4. Set `healthcheckPath` to `/health`, `healthcheckTimeout` to `30`
   (seconds) on `knotrack-server`.

---

## 2. Required environment variables (`knotrack-server`)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway reference variable — resolves to the private-network connection string, never typed out manually. |
| `NODE_ENV` | `production` | Selects the production SSL-mode default in `src/config/env.ts`. |
| `PORT` | `8080` | Must match the Dockerfile's `EXPOSE`/`HEALTHCHECK` and the generated domain's target port. |
| `KNOTRACK_API_TOKENS` | one or more `kt_...` tokens, comma-separated | Generate with `node dist/scripts/generate-token.ts` (or `npm run generate-token` locally against the built `dist/`) — never hand-type a token. |
| `KNOTRACK_ENCRYPTION_KEY` | 32 random bytes, base64 | Generate fresh per deploy target — see §4, this is the credential-at-rest key and it is genuinely irreplaceable once anything is encrypted under it. |
| `KNOTRACK_DB_SSL_CA_BASE64` | the extracted root CA, base64 (see §3) | Only needed because this Postgres image presents a self-signed cert; unset on any deploy target with a real CA chain. |

None of these are typed into this doc — they live only in Railway's own
service-variables store and were shared with Paul directly, not written
down anywhere else.

---

## 3. Extracting the self-signed Postgres CA (`KNOTRACK_DB_SSL_CA_BASE64`)

The `postgres-ssl` image has no public endpoint by default — it's reachable
only over Railway's private network (`postgres.railway.internal`). Getting
its certificate chain out requires a way to actually connect to Postgres's
TLS port from somewhere with real TCP egress. **If your own shell only has
allowlisted HTTPS egress (no arbitrary TCP), you cannot do this step
directly — you need a sandbox/host with general TCP egress first.**

1. Create a **temporary** TCP proxy on the Postgres service
   (`create-tcp-proxy`, e.g. port `5432` → some `*.proxy.rlwy.net:NNNNN`
   Railway assigns).
2. Perform Postgres's own `SSLRequest` handshake manually before you can
   see anything with TLS tooling — Postgres doesn't speak plain TLS on
   connect, it expects a specific pre-TLS negotiation first: send an 8-byte
   message (`int32(8)` length prefix + `int32(80877103)` the SSL request
   code), and the server replies with a single `S` byte if it supports SSL.
   Only after that byte can you hand the same socket to a normal TLS
   client. In practice, `openssl s_client -starttls postgres -showcerts
   -connect <proxy-host>:<proxy-port>` does this negotiation for you and
   prints the **full chain**, not just the leaf.
3. Read the chain: this image presents `CN=localhost` (leaf) issued by
   `CN=root-ca` (self-signed root, chain index 1).
4. **Pin the root CA (chain index 1), not the leaf.** The postgres-ssl
   image auto-renews its leaf certificate as it nears expiry, but keeps the
   same persistent root CA on the data volume — pinning the root survives
   renewal; pinning the leaf would silently break the connection on the
   next renewal.
5. Validate the extracted PEM before using it — this repo's own
   `decodeAndValidateSslCa()` (`src/db/ssl-config.ts`) does a real
   `X509Certificate` parse, not just a base64/shape check; run it against
   the extracted cert locally first.
6. Base64-encode the validated PEM and set it as
   `KNOTRACK_DB_SSL_CA_BASE64`.
7. **Delete the temporary TCP proxy immediately.** Postgres should have no
   public exposure once you're done — only the private network the app
   service also sits on.

When `KNOTRACK_DB_SSL_CA_BASE64` is set, it always wins over
`KNOTRACK_DB_SSL_REJECT_UNAUTHORIZED` (both in `src/db/pool.ts` and the
standalone `scripts/migrate.ts`, which deliberately doesn't go through the
same `loadConfig()`/`createPool()` path as the app and needed the same fix
applied separately). Leaving it unset changes nothing on any other deploy
target (Supabase, Fly.io, local dev) — this variable only matters against a
self-signed Postgres like this one.

---

## 4. Migrations: Pre-Deploy Command, not a chained start command

**Do not** set `deploy.startCommand` to something like `node
dist/scripts/migrate.js && node dist/src/index.js`. That was this
project's original approach and it silently never ran the migration half at
all: Railway built this service from the repo's checked-in `Dockerfile`
(see §1), whose own `CMD ["node", "dist/src/index.js"]` is the real
container entrypoint — Railway does not apply `deploy.startCommand` on top
of a Dockerfile build, regardless of what the dashboard/API shows for it.
The symptom was a server that came up healthy every time (fast, ~400ms
boot) while the schema silently never got created or updated — genuinely
dangerous, because "the server is up" looked like success.

**The actual, verified-working setup:**

- `deploy.preDeployCommand`: `["node dist/scripts/migrate.js"]`
- `deploy.startCommand`: `node dist/src/index.js` (plain — no chaining)

Railway's Pre-Deploy Command is a distinct deploy-stage mechanism, separate
from both the build path and the start command: it runs in its own
short-lived container after the build and before the app container starts,
"even when the build is skipped," and a non-zero exit blocks the deploy
outright (no retry, no partially-migrated app going live). The Dockerfile
itself is left untouched — its own code comment already says migrations
are meant to run "as a separate deploy-time step," which is exactly what
this does; the fix works with the Dockerfile's intent rather than editing
or removing it.

**Live proof this actually works** (deployment `f9e9ada5-b145-4360-9c23-5ec2d70ced90`,
commit `1b678490acf1034b902334bbed9524bb27efe59c`, a real automated redeploy
triggered by Railway's GitHub integration on a merge to `main` — not a
manual trigger):

```text
Starting Container
skip (already applied): 001_init.sql
skip (already applied): 002_projects_unique_source_ref.sql
skip (already applied): 003_drift_flags_open_unique.sql
skip (already applied): 004_adapters_key_version.sql
skip (already applied): 005_tracks_sync_timestamps.sql
no pending migrations — schema already up to date
Stopping Container
Server listening at http://127.0.0.1:8080
```

...followed by a passing healthcheck. That's a distinct pre-deploy
container running `migrate.js` to completion and exiting cleanly, *then*
the real app container starting — the mechanism this whole section exists
to get right. (`docs/ROADMAP.md`'s `T3.7`/`T3.2` cite this same deployment
as their closing evidence.)

**Pre-Deploy Timeout** is dashboard-only as of this writing — no Railway
API/MCP field exposes it (`update-service`'s schema has none). Left at
Railway's default (unlimited). Set a cap manually if needed: service →
Settings → Deploy → Pre-Deploy Timeout (1–3600s).

**T3.8's companion safety net:** even with the Pre-Deploy Command working,
`src/index.ts` also checks the schema itself at boot (before
`app.listen(...)`) and refuses to start (non-zero exit, `fatal`-level log
naming the pending file) rather than silently serving traffic against a
stale schema. This has been observed live taking the "stays silent"
branch — schema was already correct, no refusal fired, server started
normally — on the same deployment above. It has **not** been observed live
taking the refusal branch (a genuinely stale schema on a real Railway
deploy); only unit tests (`tests/unit/migration-status.test.ts`) cover that
path directly. Worth knowing if you're relying on this as your only safety
net for a truly broken deploy.

---

## 5. Secret rotation

**API tokens (`KNOTRACK_API_TOKENS`) — safely rotatable, no gap.** Generate
a new token with `scripts/generate-token.ts`, add it alongside the old one
(comma-separated), redeploy, confirm the new token works, then remove the
old one and redeploy again. No downtime: the variable holds a set, not a
single value.

**Postgres password / `DATABASE_URL` — safely rotatable via Railway.**
Regenerate `POSTGRES_PASSWORD` on the `Postgres` service; because
`knotrack-server`'s `DATABASE_URL` is a Railway *reference* variable
(`${{Postgres.DATABASE_URL}}`), it re-resolves automatically on the next
`knotrack-server` deploy — no manual copy-paste, no window where the two
services disagree about the password as long as you redeploy
`knotrack-server` promptly after rotating.

**`KNOTRACK_DB_SSL_CA_BASE64` — rotatable, but only if you re-extract the
right cert.** The postgres-ssl image auto-renews its *leaf* certificate,
which this variable deliberately does not pin (see §3) — so under normal
operation this should never need rotating. It only needs re-extraction if
the *root* CA itself changes (e.g. the Postgres service is recreated from
scratch on a new volume). Repeat §3's procedure in that case; there's no
shortcut.

**`KNOTRACK_ENCRYPTION_KEY` — NOT safely rotatable today. This is a real,
known gap, not an oversight left out of this doc.** `kt_register_project`
already encrypts GitHub/Linear adapter credentials under this key today
(`src/mcp/tools/register-project.ts` → `encryptCredential()`,
`src/crypto/credential-cipher.ts`) even though the T5 sync adapters
themselves aren't built yet — so if this deployment has ever had a project
registered with adapter credentials, rotating this key without a
re-encryption path would make those specific stored credentials
permanently unreadable. `docs/ROADMAP.md`/the adversarial-review backlog
already tracks this: the TRD documents an `npm run rotate-encryption-key`
command that doesn't actually exist, and there's no
`scripts/rotate-encryption-key.ts` to decrypt-under-old-key /
re-encrypt-under-new-key. **Until that script exists, do not rotate this
variable on any deployment that has real adapter credentials stored.** If
the key is ever suspected compromised before that script exists, the only
safe response today is re-registering affected projects' adapter
credentials from scratch under a new key, not an in-place rotation.

---

## 6. Rollback

Railway keeps deployment history per service (`list-deployments`). Two
paths, depending on what broke:

- **Bad app code, schema unaffected:** find the last-known-good deployment
  in the Railway dashboard (Deployments tab on the service) and use its
  "..." menu → **Redeploy** on that specific past deployment. The MCP
  `redeploy` tool only re-runs the *current* service's most recent
  deployment — it has no parameter to target an older one, so this step is
  dashboard-only. Because this service is GitHub-sourced, `git revert` +
  push to `main` and letting auto-deploy pick it up is the alternative, and
  is generally the safer/more auditable of the two for anything beyond a
  single-click emergency rollback.
- **Bad migration:** this project has **no automated migration rollback**
  (`docs/ROADMAP.md`/the backlog already tracks this as a known gap —
  `scripts/migrate.ts` only applies forward, there's no guarded "down"
  mode despite the roadmap documenting a `migrate down` command). Rolling
  back a bad migration today means writing and applying a new
  forward-only migration that undoes the damage, not reverting the
  deployment — reverting the app code alone would leave the schema in
  whatever state the bad migration left it in, potentially incompatible
  with the *older* app code you just rolled back to. Treat this as
  something to fix before this project is depended on by anyone who isn't
  actively watching a rollback in real time.

---

## What this runbook deliberately does not cover

- **`T3.5` (real MCP client verification).** Needs an actual client (Claude
  Desktop, Claude Code, etc.) under a human's control pointed at
  `https://knotrack-server-production.up.railway.app/mcp` with an issued
  bearer token, making a real `kt_register_project`/`kt_create_track`
  call and getting back the tool's real success payload — not something
  this runbook or an unattended session can complete on its own.
- **Second-client / T4 verification, adapter (T5) setup, and drift
  heuristics (T6).** Out of scope for a deploy runbook; see
  `docs/ROADMAP.md` for those tracks.
