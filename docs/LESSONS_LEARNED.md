# Lessons Learned

This is a standing, append-only log of things the team paid real cost to learn — the
kind of mistake that's cheap to prevent next time and expensive to re-learn from
scratch. It is not a changelog and not a postmortem archive with full timelines; it's
the distilled, reusable lesson.

**Read this before touching deploy/infra config, and before trusting any "looks
correct" status claim about a running system.** When you pay real cost to learn
something new, append a dated entry using the template at the bottom, so lessons
compound instead of being re-learned by the next person (or by the same person, in
six months, having forgotten).

---

## 2026-08-29 — Railway silently ran the checked-in Dockerfile, not the configured start command

**What happened.** Production KnoTrack (an MCP server backed by Postgres) had a
completely empty database — zero tables, not even the `schema_migrations`
bookkeeping table the migration runner creates unconditionally on every run — despite
three prior deployments. This was only discovered when a real write-path tool call
(`kt_register_project`) failed with `relation "projects" does not exist`. Migrations
had never once run against production.

**Why it was missed the first time.** The day before, several roadmap items had been
marked "verified live" based on a health-check endpoint returning 200 and a
successful MCP `initialize` handshake succeeding. Neither of those touches the
database at all. This is worth naming as its own lesson, independent of anything
Railway-specific: **a health check and a protocol handshake are not a database test.**
If the thing you're verifying has a write path, the only real verification is
exercising that write path. "The server is up and speaking the protocol" and "the
server can actually do its job" are different claims, and it's easy to accidentally
verify only the first one and report the second.

**Root cause.** Railway's service config (dashboard and API alike) reported
`build.builder: "RAILPACK"` and a `deploy.startCommand` that chained
`migrate.js && index.js`. Both looked correct. Neither was what actually ran. The
repo also had a standalone `Dockerfile`, left over from an earlier deployment
approach, whose baked-in `CMD` just started the server with no migration step. It was
assumed inert because the dashboard said RAILPACK was the active builder — but
Railway's own documentation states plainly that "Railway will always build with a
Dockerfile if it finds one," regardless of what the builder setting displays. This
was confirmed by reading Railway's **build logs** (not deploy logs — the two are
separate log streams, and this is exactly why the discrepancy wasn't visible at
first glance): the build logs showed the service being built from the checked-in
Dockerfile, stage-for-stage, the entire time. The Dockerfile's `CMD` was the one and
only real entrypoint, across all three deployments this service has ever had; the
separately configured `deploy.startCommand` had never once taken effect. This is a
platform behavior (an override precedence that isn't reflected back into the config
UI/API you'd naturally check), not a bug in KnoTrack's own code.

**The general, transferable principle:**

> A config value that "looks correct" wherever you check it — a dashboard, an API
> response, even the platform's own documentation of intent — is not evidence that
> it's actually applied to the thing currently running. The only real evidence is
> observing the running thing's own behavior or logs.

**Fix adopted:**

1. Set Railway's `deploy.preDeployCommand` to run the migration script — a
   deploy-stage mechanism, distinct from both the build path and
   `deploy.startCommand`, specifically documented for this purpose. It runs even when
   the build is skipped and blocks the deploy outright (no retry) on failure. Reset
   `deploy.startCommand` back to a plain server start, since the migrate-then-start
   chain there had never once been honored and leaving it in place was actively
   misleading.
2. Added a boot-time schema-freshness guard in the server's own startup path
   (roadmap item T3.8): before accepting traffic, check for unapplied migrations and,
   if any exist, log a fatal error and exit non-zero rather than serve against a
   broken schema. This is the part that stays true no matter what any platform config
   field does in the future — it doesn't depend on trusting a setting again.
3. Deliberately did **not** commit the Railway config to a `railway.json`/
   `railway.toml` file, despite that being a reasonable-sounding suggestion (make the
   config visible in git, not just in a dashboard). Checking Railway's own docs found
   that file format is deprecated and stops being read entirely on 2026-12-01. The
   modern replacement (an Infrastructure-as-Code `.railway/railway.ts` file plus a
   CLI plan/apply workflow) is real but a bigger adoption than this bug justified —
   worth knowing about, not worth doing reactively.
4. Left the Dockerfile untouched — the Pre-Deploy Command approach fulfills what the
   Dockerfile's own code comment already said the intent was, rather than fighting it.
5. Verification going forward means reading the actual pre-deploy log lines from the
   migration runner itself on the next real deploy — not just confirming the API call
   that set the config succeeded. "The API accepted my config change" was exactly the
   false confidence that caused this incident in the first place.
6. Documented fallback if Pre-Deploy Command also turns out to be silently unhonored:
   bake the migration directly into the Dockerfile's `CMD` — the one mechanism
   already proven, empirically, to be this service's real entrypoint.

---

## Entry template

Copy this for each new entry. Keep it factual — what happened, not how it felt.

```
## YYYY-MM-DD — <short title>

**Date:** YYYY-MM-DD

**What happened:** <the observable symptom / failure, plainly stated>

**Why it was missed:** <what check gave false confidence, and specifically why
that check didn't actually cover the thing that broke>

**Root cause:** <the actual mechanism — distinguish "our bug" from "platform/tool
behavior we didn't know about">

**Lesson:** <the general, transferable principle — should make sense to someone
with zero context on this specific incident>

**Fix:** <what was changed, numbered if there's more than one part>
```
