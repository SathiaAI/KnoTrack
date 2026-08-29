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

function runHardCheck(): boolean {
  const fromCode = getStubToolNamesFromCode();
  const fromDoc = getStubToolNamesFromRoadmap();
  const codeSet = new Set(fromCode);
  const docSet = new Set(fromDoc);
  const onlyInCode = fromCode.filter((t) => !docSet.has(t));
  const onlyInDoc = fromDoc.filter((t) => !codeSet.has(t));

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

function runSoftCheck(): void {
  let diffBase: string;
  try {
    diffBase = execSync('git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    console.log('(soft check skipped — no git history to diff against, e.g. a shallow clone)');
    return;
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
