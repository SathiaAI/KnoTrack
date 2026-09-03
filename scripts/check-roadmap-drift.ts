#!/usr/bin/env tsx
// CI gate against the exact failure mode found 2026-08-28: docs/ROADMAP.md
// claiming a tool's implementation status that no longer matches the code.
// Runs in GitHub Actions on every PR (.github/workflows/ci.yml) and exits
// non-zero — a real check with a real exit code, not a reminder someone
// has to remember to read.
//
// Deliberately narrow rather than a general "prose vs. code" NLP checker
// (see the 2026-08-29 OSS survey behind this decision — nothing off the
// shelf does semantic prose/code cross-checking; every real tool in that
// space either flags "code near this doc changed, go re-check it"
// (fiberplane/drift) or requires a hand-written rule (danger.js). This is
// the hand-written rule for KnoTrack's specific, recurring failure: a
// tool's stub/real status drifting from what the roadmap says about it.
//
// Two checks:
//   1. HARD (exit 1): the stub-tool marker in ROADMAP.md must exactly
//      match the STUBS array in src/mcp/tools/stubs.ts. This is the
//      deterministic core — no free-text parsing, just two lists compared.
//   2. SOFT (warning only, exit 0): if this run has git history available,
//      warn when files under src/mcp/tools/, src/domain/, or migrations/
//      changed without docs/ROADMAP.md changing in the same diff. This
//      won't catch everything and isn't meant to — it's a cheap nudge,
//      not a semantic guarantee.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const STUBS_FILE = path.join(REPO_ROOT, 'src/mcp/tools/stubs.ts');
const ROADMAP_FILE = path.join(REPO_ROOT, 'docs/ROADMAP.md');
const MARKER_REGEX = /<!-- STUB_TOOLS: ([^>]+?) -->/;

/**
 * Parses `src/mcp/tools/stubs.ts`'s `STUBS` array for every `name: 'kt_...'`
 * entry, sorted. This is the code side of the drift check — the actual,
 * current set of tools still implemented as stubs, independent of whatever
 * `docs/ROADMAP.md`'s marker claims.
 */
function getStubToolNamesFromCode(): string[] {
  const src = readFileSync(STUBS_FILE, 'utf8');
  const names = [...src.matchAll(/name:\s*'(kt_[a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
  if (names.length === 0) {
    throw new Error(
      `check-roadmap-drift: found zero tool names in ${path.relative(REPO_ROOT, STUBS_FILE)} ` +
        `— the parser regex probably needs updating to match a code change, not a real "no stubs" state ` +
        `(if KnoTrack ever legitimately reaches 14/14 real tools, delete this script's hard check instead ` +
        `of letting it silently pass on zero).`,
    );
  }
  return names.sort();
}

/**
 * Parses `docs/ROADMAP.md`'s `<!-- STUB_TOOLS: ... -->` marker into a
 * sorted list of tool names. This is the doc side of the drift check — the
 * roadmap's own claim about which tools are still stubs, compared against
 * `getStubToolNamesFromCode`'s result by `runHardCheck`.
 */
function getStubToolNamesFromRoadmap(): string[] {
  const doc = readFileSync(ROADMAP_FILE, 'utf8');
  const match = doc.match(MARKER_REGEX);
  const marker = match?.[1];
  if (marker === undefined) {
    throw new Error(
      `check-roadmap-drift: no "<!-- STUB_TOOLS: ... -->" marker found in ` +
        `${path.relative(REPO_ROOT, ROADMAP_FILE)}. This marker is the ground-truth claim the ` +
        `roadmap makes about which tools are still stubs — add it back near T2's status ` +
        `paragraph rather than removing this check.`,
    );
  }
  return marker
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/**
 * The deterministic HARD check (see file header): compares the stub-tool
 * list from code against the one claimed in the roadmap marker and prints
 * exactly what's out of sync. Returns `true` when they match (caller uses
 * this to decide the script's exit code) — this function itself never
 * exits the process, so it stays unit-testable in isolation.
 */
function runHardCheck(): boolean {
  const fromCode = getStubToolNamesFromCode();
  const fromDoc = getStubToolNamesFromRoadmap();
  // Both arrays are already .sort()ed by the functions above. A true
  // multiset diff (two-pointer merge over the sorted arrays) rather than
  // a positional or Set-based comparison: a Set-based comparison hides a
  // duplicate entry on one side (adversarial PR review finding:
  // `new Set(fromCode)` vs. `new Set(fromDoc)` collapses duplicates
  // before comparing, so code `['kt_a']` vs. a marker of `'kt_a, kt_a'`
  // would incorrectly report a match), and a plain index-wise comparison
  // still mislabels *which* names differ once a duplicate shifts every
  // later index out of alignment (adversarial PR review finding: code
  // `['kt_a', 'kt_a', 'kt_b']` vs. marker `['kt_a', 'kt_b']` differ only
  // in how many times `kt_a` appears, but index-wise comparison reports
  // `kt_b` as both "missing from the marker" and "no longer a stub in
  // code" — a real, confusing false claim about `kt_b`, even though the
  // check still correctly fails overall). Counting occurrences per name
  // and reporting only the surplus on each side gets both the pass/fail
  // outcome and the diagnostic message right.
  const onlyInCode: string[] = [];
  const onlyInDoc: string[] = [];
  let codeIndex = 0;
  let docIndex = 0;
  while (codeIndex < fromCode.length && docIndex < fromDoc.length) {
    const codeName = fromCode[codeIndex];
    const docName = fromDoc[docIndex];
    if (codeName === docName) {
      codeIndex++;
      docIndex++;
    } else if (codeName! < docName!) {
      onlyInCode.push(codeName!);
      codeIndex++;
    } else {
      onlyInDoc.push(docName!);
      docIndex++;
    }
  }
  onlyInCode.push(...fromCode.slice(codeIndex));
  onlyInDoc.push(...fromDoc.slice(docIndex));

  if (onlyInCode.length === 0 && onlyInDoc.length === 0) {
    console.log(`✓ Stub-tool list matches: [${fromCode.join(', ')}]`);
    return true;
  }

  console.error("✗ docs/ROADMAP.md's STUB_TOOLS marker has drifted from src/mcp/tools/stubs.ts:");
  if (onlyInCode.length > 0) {
    console.error(
      `  Still a stub in code but NOT listed in the roadmap marker: ${onlyInCode.join(', ')}`,
    );
  }
  if (onlyInDoc.length > 0) {
    console.error(
      `  Listed as a stub in the roadmap marker but NO LONGER a stub in code (shipped — update the ` +
        `marker AND the surrounding prose, e.g. the reconciliation note and Track status header): ${onlyInDoc.join(', ')}`,
    );
  }
  return false;
}

/**
 * The SOFT check (see file header): warns, but never fails the build, when
 * this diff touches `src/mcp/tools/`, `src/domain/`, or `migrations/`
 * without also touching `docs/ROADMAP.md`. Best-effort only — see
 * `ROADMAP_DIFF_BASE` handling below for the one case (a `push` to `main`)
 * where the naive git-history diff base would silently disable this check
 * entirely.
 */
function runSoftCheck(): void {
  // On a `push` to main, actions/checkout has already advanced the local
  // origin/main ref to the just-pushed commit by the time this runs, so
  // `git merge-base HEAD origin/main` resolves to HEAD itself and the diff
  // below becomes HEAD..HEAD — always empty, silently disabling this check
  // for every direct push (CodeRabbit + Codex review finding). CI sets
  // ROADMAP_DIFF_BASE to the push event's pre-push SHA (github.event.before)
  // for exactly this case; it's unset (empty string) on pull_request events,
  // where the merge-base fallback below is already correct.
  const envDiffBase = process.env.ROADMAP_DIFF_BASE?.trim();
  let diffBase: string;
  if (envDiffBase) {
    diffBase = envDiffBase;
  } else {
    try {
      diffBase = execSync('git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
    } catch {
      console.log('(soft check skipped — no git history to diff against, e.g. a shallow clone)');
      return;
    }
  }
  let changed: string[];
  try {
    changed = execSync(`git diff --name-only ${diffBase} HEAD`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    console.log('(soft check skipped — git diff failed, not treating this as a hard failure)');
    return;
  }
  const touchedImplementation = changed.some(
    (f) =>
      f.startsWith('src/mcp/tools/') || f.startsWith('src/domain/') || f.startsWith('migrations/'),
  );
  const touchedRoadmap = changed.includes('docs/ROADMAP.md');
  if (touchedImplementation && !touchedRoadmap) {
    console.warn(
      '⚠ This change touches src/mcp/tools/, src/domain/, or migrations/ but not docs/ROADMAP.md. ' +
        "Not a failure — plenty of code changes don't close a roadmap item — but worth a second look " +
        'before merging: does any Track/Item status line need updating?',
    );
  }
}

const hardCheckPassed = runHardCheck();
runSoftCheck();
process.exit(hardCheckPassed ? 0 : 1);
