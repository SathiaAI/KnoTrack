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
| `Postgres` | `ghcr.io/railwayapp-templates/postgres-ssl` — **currently unpinned** (no tag), see the callout below | managed Postgres, self-signed TLS |
| `knotrack-server` | GitHub source, `SathiaAI/KnoTrack` `main`, built from the repo's own `Dockerfile` | the MCP server |

**Known gap, not yet fixed on the live service: the image reference above is
untagged, which Docker/GHCR resolve as `:latest`.** Verified directly against
the live `Postgres` service's stored config (`ghcr.io/railwayapp-templates/postgres-ssl`,
no tag) — so a future upstream push to `latest` could change the running
image on this project's next redeploy without anyone choosing that. Pin a
tested minor-version tag (e.g. `:17`) or, preferably, an immutable digest
(`ghcr.io/railwayapp-templates/postgres-ssl@sha256:...`) instead, both in any
new service you provision from this table and (separately, via
`update-service`, not covered by this docs-only runbook) on the existing live
service.

**To provision from scratch:**

1. Create a Railway project, add a new service from the
   `railwayapp-templates/postgres-ssl` Docker image — **pinned to a specific
   tag or digest, not the bare `.../postgres-ssl` reference** (see the
   callout above) — and not Railway's default "Add Postgres" plugin either,
   since that one doesn't support pinning a custom CA the way this project
   needs (see §3). Attach a persistent volume mounted at
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
   - **`DATABASE_URL` on the `Postgres` service itself — verify it exists,
     don't assume it.** This project's live `Postgres` service does carry a
     `DATABASE_URL` variable (confirmed directly via
     `mcp__Railway__get-service-config`'s `variableNames`, alongside
     `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/`PGDATA`) —
     provisioning through Railway's own template "Deploy" flow for this
     image composes it automatically from the other four variables.
     **That composition is not documented anywhere in the
     `railwayapp-templates/postgres-ssl` repo itself and is not guaranteed
     if you provision the image a different way** (e.g. adding a bare
     "Docker Image" service by hand rather than using the template's own
     deploy button) — in that case `${{Postgres.DATABASE_URL}}` in §2 below
     resolves to nothing, and both the pre-deploy migration and server
     startup fail with a missing connection string. After provisioning,
     check the `Postgres` service's variable list; if `DATABASE_URL` is
     absent, add it yourself as a Railway reference-variable expression
     composed from the same private-network endpoint this service exposes
     (`postgres` on this project, confirmed via `get-service-config`'s
     `networking.privateNetworkEndpoint`), e.g.
     `postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{POSTGRES_DB}}` —
     never a value typed out by hand.
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
| `KNOTRACK_API_TOKENS` | one or more `kt_...` tokens, comma-separated | Generate with `node dist/scripts/generate-token.js` — the production image only ever has the compiled `dist/scripts/generate-token.js` (`npm ci --omit=dev` strips `tsx`, and only `dist` is copied into the runtime stage; see the Dockerfile). `npm run generate-token` (which runs `tsx scripts/generate-token.ts`) works from a local source checkout, but never against the deployed image. Never hand-type a token. |
| `KNOTRACK_ENCRYPTION_KEY` | 32 random bytes, base64 | Generate fresh per deploy target with `openssl rand -base64 32` — this is the credential-at-rest key (`src/crypto/credential-cipher.ts`) and it is genuinely irreplaceable once anything is encrypted under it. Store the generated value somewhere durable before setting it; see §5 for what "irreplaceable" means in practice and the one supported rotation path. |
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
4. **Pin the root CA (chain index 1), not the leaf** — the leaf alone is
   useless to pin, since it's the certificate that actually expires and
   gets replaced. **Correction, verified 2026-09-03 against the upstream
   `railwayapp-templates/postgres-ssl` scripts directly (this doc
   previously claimed the opposite): the root CA does *not* reliably
   survive renewal either.** The image's `wrapper.sh` calls `init-ssl.sh`
   — which regenerates *both* `root.crt`/`root.key` and the leaf, with no
   check for an existing root to preserve — not only on first init, but
   also whenever the current leaf is within 30 days of expiring
   (`openssl x509 -checkend 2592000`) on an already-initialized volume.
   So on this image, as shipped, chain index 1 can and will change on its
   own roughly once per certificate lifetime (`SSL_CERT_DAYS`, default
   820 days) even though the Postgres data volume itself is never
   recreated. **Practical consequence: treat a pinned
   `KNOTRACK_DB_SSL_CA_BASE64` as having a shelf life tied to
   `SSL_CERT_DAYS`, not as a one-time, permanent extraction** — track when
   it was last extracted and re-run this procedure proactively before
   that window closes, rather than waiting for connections to start
   failing. (There is no notification when the image silently rotates the
   root out from under a stale pinned value; the failure mode is TLS
   handshake errors on both the app and `scripts/migrate.ts`.)
5. Validate the extracted PEM before using it — this repo's own
   `decodeAndValidateSslCa()` (`src/db/ssl-config.ts`) does a real
   `X509Certificate` parse, not just a base64/shape check; run it against
   the extracted cert locally first.
6. Base64-encode the validated PEM **as a single unwrapped line** and set
   it as `KNOTRACK_DB_SSL_CA_BASE64` — e.g. `base64 -w0 ca.pem` (GNU
   coreutils) or `openssl base64 -A -in ca.pem` (works the same on the
   BSD/macOS `base64`, which has no `-w` flag). **Do not use plain `base64
   ca.pem`** — GNU `base64`'s default 76-column line wrapping produces a
   multi-line string, and `decodeAndValidateSslCa()`'s `STRICT_BASE64`
   regex (`src/db/ssl-config.ts`) is anchored (`^...$`, no multiline flag)
   and rejects any embedded newline outright — both the migration step and
   server startup fail before ever attempting a database connection.
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
"even when the build is skipped," and a non-zero exit blocks *that
deployment* outright (no retry, the new app container never starts). The
Dockerfile itself is left untouched — its own code comment already says
migrations are meant to run "as a separate deploy-time step," which is
exactly what this does; the fix works with the Dockerfile's intent rather
than editing or removing it.

**What a blocked pre-deploy does *not* guarantee: that no partially-migrated
schema is ever live.** `applyMigrations()` (`scripts/migrate.ts`) wraps each
migration *file* in its own transaction, not the whole batch in one — by
design, since a genuinely single cross-file transaction would hold Postgres
locks for the duration of every pending migration, and a failed later file
still needs earlier files' work preserved rather than rolled back with it.
So if migration 3 of 5 fails, files 1–2 are already committed and the
Pre-Deploy Command exits non-zero: the *new* app version never starts, but
the *previous* app deployment (built against the pre-migration schema) is
still the one serving traffic on a database that mid-deploy-batch is
neither the old schema nor the new one. Whether that's safe depends
entirely on whether the applied-so-far migrations are backward-compatible
with the still-running old code — which is on the person writing each
migration to ensure, not something this pre-deploy mechanism enforces.
**Practical guidance:** write migrations to be backward-compatible with the
previous app version whenever a batch has more than one file (additive
schema changes deployed ahead of the code that relies on them, not
simultaneous rename/drop-and-add-in-one-migration), and if a Pre-Deploy
Command run does fail partway, treat it as an incident — check
`schema_migrations` directly to see exactly which files committed before
deciding whether it's safe to keep serving the old app version or take the
service down — not something to retry blindly.

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

**Pre-Deploy Timeout — set a finite value; don't leave this on Railway's
unlimited default in production.** `applyMigrations()` acquires a session
advisory lock (`pg_advisory_lock`, `scripts/migrate.ts`) before it even
reads which migrations are pending, and by design `pg_advisory_lock` blocks
indefinitely if another session already holds that same lock (e.g. a
concurrent migration run, or a stuck connection that never released it) —
Postgres has no built-in timeout on it. With no Pre-Deploy Timeout set, a
lock contention or a hung connection stalls the pre-deploy container
forever rather than failing loudly, holding up the deployment (and, on this
project's single-replica setup, blocking any further deploys) with no
automatic recovery. This field is dashboard-only as of this writing — no
Railway API/MCP field exposes it (`update-service`'s schema has none), so it
can't be set from this runbook's other automated steps. Set it manually:
service → Settings → Deploy → Pre-Deploy Timeout (1–3600s) — pick a value
comfortably above how long a real migration run takes (well under a minute
for this project's migrations as of this writing), not the maximum.

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
a new token with `node dist/scripts/generate-token.js` (see §2 — the
compiled path, not the `.ts` source, against a deployed image), add it
alongside the old one (comma-separated), redeploy, confirm the new token
works, then remove the old one and redeploy again. No downtime: the
variable holds a set, not a single value.

**Postgres password / `DATABASE_URL` — needs a database-side change first;
regenerating the Railway variable alone breaks the connection.** This
image inherits the official Postgres entrypoint's initialization behavior:
`POSTGRES_PASSWORD` is only ever consumed the *first* time it initializes
an empty `PGDATA` — on every subsequent boot against the already-populated
persistent volume this project uses, the variable is read but ignored, and
the role's actual password in Postgres stays whatever it was set to at
first init. Regenerating `POSTGRES_PASSWORD` in Railway and redeploying
`knotrack-server` (so its `${{Postgres.DATABASE_URL}}` reference re-resolves
to the new value) does **not** rotate anything database-side — it just
makes every service connect with a password Postgres no longer recognizes,
breaking the app outright. **Correct sequence:**
1. Connect to Postgres with the *current* (old) credentials and run
   `ALTER ROLE <POSTGRES_USER> WITH PASSWORD '<new-password>';` yourself —
   this is the only step that actually changes what Postgres accepts.
2. Only then update the `POSTGRES_PASSWORD` variable on the `Postgres`
   service to the same new value (so it stays consistent with what you just
   set, and so the next from-scratch init would produce the same
   password — it does not re-apply the password to a live cluster, see
   above).
3. Redeploy `knotrack-server` so its `${{Postgres.DATABASE_URL}}` reference
   re-resolves; confirm connectivity (`/health` reporting `db: ok`) before
   considering the rotation done.

**`KNOTRACK_DB_SSL_CA_BASE64` — expect to rotate this periodically, not
just on a volume recreation.** §3's extraction procedure now documents
(corrected 2026-09-03) that the postgres-ssl image regenerates *both* the
leaf **and the root CA** together whenever the leaf nears expiry
(`SSL_CERT_DAYS`, default 820 days) — not only when the Postgres service is
rebuilt from scratch on a new volume. Track the extraction date and
re-run §3's full procedure before that window closes; there is no
in-place "just update the leaf" shortcut, and no automatic warning when the
image rotates the root out from under a stale pinned value — the failure
mode is a TLS handshake failure on both `knotrack-server` and
`scripts/migrate.ts` the next time either connects.

**`KNOTRACK_ENCRYPTION_KEY` — safely rotatable via
`scripts/rotate-encryption-key.ts`, with real downtime and a strict
sequence; this is a real, working script as of this writing, not an
aspirational one.** `kt_register_project` already encrypts GitHub/Linear
adapter credentials under this key today
(`src/mcp/tools/register-project.ts` → `encryptCredential()`,
`src/crypto/credential-cipher.ts`) even though the T5 sync adapters
themselves aren't built yet — so if this deployment has ever had a project
registered with adapter credentials, the rotation itself, not just leaving
the key alone, is what protects those credentials from becoming
permanently unreadable. `scripts/rotate-encryption-key.ts` (added since an
earlier version of this doc, which incorrectly said no such script
existed — confirmed present, with its own unit/integration coverage, by
reading the file directly) decrypts every stored `adapters` row under the
*current* key and re-encrypts it under a *new* one inside a single
database transaction, so a failure partway through rolls back every row
rather than leaving some on the old key and some on the new one. **Sequence
(the script's own header comment documents this in full):**
1. Generate the new key and keep it somewhere durable —
   `export KNOTRACK_ENCRYPTION_KEY_NEW=$(openssl rand -base64 32)` (an
   `export`, not a same-line `VAR=value command` prefix, so it survives in
   your shell after the command exits — losing it mid-rotation makes
   every just-rotated credential permanently undecryptable).
2. Quiesce writes to the `adapters` table — stop `knotrack-server` or
   otherwise pause traffic that could call `kt_register_project` mid-run.
3. Run the script against the deployed image:
   `node dist/scripts/rotate-encryption-key.js` (the production runtime
   has no `tsx`, same constraint as §2's token generator — local dev uses
   `npm run rotate-encryption-key` instead). It also prints the new key
   back to stdout on success, as a second line of defense against losing
   the value from step 1.
4. Set `KNOTRACK_ENCRYPTION_KEY` to the new value in Railway and redeploy
   `knotrack-server` — **do not restart the server with the old key still
   configured** once the script has committed; the database now holds
   credentials encrypted under the new key exclusively.
If the key is ever suspected compromised, running this rotation is the
correct response — re-registering affected projects' adapter credentials
from scratch is no longer the only option now that this script exists.

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
- **Bad migration, reversible (added/changed a column, added a table, wrong
  default value, etc.):** this project has **no automated migration
  rollback** (`docs/ROADMAP.md`/the backlog already tracks this as a known
  gap — `scripts/migrate.ts` only applies forward, there's no guarded
  "down" mode despite the roadmap documenting a `migrate down` command).
  Rolling back a bad migration today means writing and applying a new
  forward-only migration that undoes the damage, not reverting the
  deployment — reverting the app code alone would leave the schema in
  whatever state the bad migration left it in, potentially incompatible
  with the *older* app code you just rolled back to.
- **Bad migration, destructive (dropped a column/table, or a `UPDATE`/data
  transform that overwrote values in place):** a forward-only corrective
  migration **cannot** recover this — there is no data left to write back,
  only a schema shape to restore. This is a real, currently-uncovered gap,
  not a variant of the reversible case above: **this project's Postgres
  service does not have backups or point-in-time recovery enabled.** The
  `postgres-ssl` image ships pgBackRest but leaves it dormant unless
  `WAL_ARCHIVE_BUCKET` is explicitly set (confirmed directly against the
  upstream image's own documented behavior), and this deployment has never
  set that variable — so as of this writing, a destructive migration
  against the live database is **not recoverable** by any means this
  runbook or the project currently provides. Two real mitigations, neither
  yet done here:
  1. **Before running any migration that drops or overwrites data**, take a
     manual snapshot first — `pg_dump` against the database (reachable the
     same way §3 reaches it for CA extraction: a temporary TCP proxy from a
     host with real TCP egress, or `railway connect` if running this from a
     machine Railway's CLI supports) to a file kept somewhere outside the
     Railway project, so there is at least one recovery point immediately
     before the risky change.
  2. **For durable, ongoing protection**, enable pgBackRest PITR by setting
     `WAL_ARCHIVE_BUCKET` (and the S3-compatible credentials it requires)
     on the `Postgres` service, per the `railwayapp-templates/postgres-ssl`
     image's own documentation — not yet done on this project's live
     service; tracked as a gap by this runbook, not silently assumed
     covered.
  Treat both the missing rollback tooling and the missing backup coverage
  as something to fix before this project is depended on by anyone who
  isn't actively watching a migration in real time.

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
