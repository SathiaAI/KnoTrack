# Contributing to KnoTrack

## Keeping `docs/ROADMAP.md` accurate

`docs/ROADMAP.md` is the project's status document until `T8` (dogfood
cutover) replaces it with KnoTrack tracking its own build. Until then it's
hand-maintained Markdown, which means it only stays true if the person
merging a change keeps it true. It has already drifted from reality more
than once — see the "Keeping this doc honest" note near the top of that
file for what happened and why.

**If your PR completes a Track Item's acceptance criterion, update that
Item's Track `Status:` line in the same PR.** Not a follow-up, not "I'll
get to it" — reviewers should treat a status update as part of the
change, the same way they'd expect a test update alongside a behavior
change. If the change only partially satisfies a Track, say so explicitly
rather than leaving whatever the line said before.

**If your PR depends on a Track/Item the roadmap marks `done` or
complete, don't take that at face value** — spot-check the actual
acceptance criterion against the code before building on it. This
project's own audit trail (see `docs/ROADMAP.md`'s backlog section) has
found real gaps between "the doc says done" and "the code actually does
this" more than once.

## Standing engineering conventions

- Every functional requirement in `docs/PRD.md` should map to a section
  in `docs/TRD.md`. If you change one without the other, that's the kind
  of drift the 2026-08-24 documentation-completeness audit had to sweep
  up after the fact — fix it in the same PR instead.
- `docs/ROADMAP.md`'s backlog section is where scoped-but-deferred work
  lives (with a stated reason and, where possible, a trigger condition
  for revisiting) — not silence, and not a TODO comment buried in code
  that nothing else points to.
- Adversarial review findings that get suppressed rather than fixed need
  a technical justification and an expiry date (see the backlog's
  "Accepted risk" entries for the pattern) — a suppression that never
  expires is a decision nobody has to defend twice.

## Dogfooding (future — `T8`)

Once `T8` lands, all further KnoTrack development sessions are recorded
via `kt_record_session_summary` against KnoTrack's own tracked instance,
and this file will be updated to describe that as the actual process
rather than a future intention.
