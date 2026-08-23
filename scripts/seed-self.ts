#!/usr/bin/env tsx
// KnoTrack's own dogfood seed. Assumes the server/DB are already up (the
// migration has been applied — see scripts/migrate.ts) and calls the 5
// implemented tools' underlying service functions directly, in-process —
// simpler and more direct than round-tripping through HTTP for a one-shot
// seed script.
//
// What this does, matching docs/ROADMAP.md's T1:
//   (a) registers KnoTrack itself as a project
//       (source_type: "github", source_ref: "pjpoulose/knotrack")
//   (b) creates Track 1 ("Spec sign-off")
//   (c) creates its 6 items (T1.1-T1.6)
//   (d) records one session summary describing this build session
//
// This is the dogfooding step: running it leaves real rows in the local
// Postgres database proving KnoTrack tracked its own first real session.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { registerProjectService } from '../src/mcp/tools/register-project.js';
import { createTrackService } from '../src/mcp/tools/create-track.js';
import { createItemService } from '../src/mcp/tools/create-item.js';
import { recordSessionSummaryService } from '../src/mcp/tools/record-session-summary.js';
import { getProjectStatusService } from '../src/mcp/tools/get-project-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Files touched during this build session: every doc under docs/, the
 * migration pair, and every scaffold file under src/scripts/tests plus
 * the top-level project config files — walked from disk so the list is
 * always accurate rather than hand-maintained. */
function listTrackedFiles(): string[] {
  const roots = ['docs', 'migrations', 'src', 'scripts', 'tests'];
  const topLevelFiles = [
    'package.json',
    'tsconfig.json',
    'eslint.config.js',
    '.prettierrc.json',
    '.env.example',
    'Dockerfile',
    'vitest.config.ts',
  ];

  const files: string[] = [...topLevelFiles];

  const walk = (relDir: string): void => {
    const absDir = path.join(REPO_ROOT, relDir);
    for (const entry of readdirSync(absDir)) {
      const relPath = path.join(relDir, entry);
      const absPath = path.join(REPO_ROOT, relPath);
      const stat = statSync(absPath);
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
        walk(relPath);
      } else {
        files.push(relPath);
      }
    }
  };

  for (const root of roots) {
    walk(root);
  }

  return files.sort();
}

const T1_ITEMS = [
  'T1.1 — PRD finalized and approved',
  'T1.2 — TRD finalized and approved',
  'T1.3 — Architecture doc finalized',
  'T1.4 — DB schema finalized',
  'T1.5 — Test case matrix authored for all 14 MCP tools',
  'T1.6 — Cross-document consistency pass',
];

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);

  try {
    console.log('(a) registering KnoTrack itself as a project...');
    const { project_id } = await registerProjectService(pool, config, {
      name: 'KnoTrack',
      source_type: 'github',
      source_ref: 'pjpoulose/knotrack',
      adapters: undefined,
    });
    console.log(`    project_id = ${project_id}`);

    console.log('(b) creating Track 1 ("Spec sign-off")...');
    const { track_id } = await createTrackService(pool, config, {
      project_id,
      title: 'Spec sign-off',
      depends_on: [],
      source_doc_ref: 'docs/ROADMAP.md#t1--spec-sign-off',
    });
    console.log(`    track_id = ${track_id}`);

    console.log('(c) creating T1.1-T1.6 items...');
    const itemIds: string[] = [];
    for (const title of T1_ITEMS) {
      const { item_id } = await createItemService(pool, config, {
        project_id,
        track_id,
        title,
        sequence_position: undefined,
        depends_on: [],
      });
      itemIds.push(item_id);
      console.log(`    ${title} -> ${item_id}`);
    }

    console.log('(d) recording session summary for this build session...');
    const filesTouched = listTrackedFiles();
    const { event_id, drift_flags_raised } = await recordSessionSummaryService(pool, config, {
      project_id,
      track_id,
      summary_text:
        'Initial spec package (PRD/TRD/Architecture/DB schema/test cases/roadmap) authored ' +
        'and reconciled; initial 5-tool server scaffold built and tested against local Postgres.',
      files_touched: filesTouched,
      items_touched: itemIds,
    });
    console.log(`    event_id = ${event_id}`);
    if (drift_flags_raised.length > 0) {
      console.log(`    drift_flags_raised = ${JSON.stringify(drift_flags_raised)}`);
    }

    console.log('\nVerifying via kt_get_project_status...');
    const status = await getProjectStatusService(pool, config, { project_id });
    console.log(JSON.stringify(status, null, 2));

    console.log('\nSeed complete. KnoTrack has now tracked its own first real session.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('seed-self failed:', error);
  process.exit(1);
});
