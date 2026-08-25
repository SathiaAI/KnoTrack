#!/usr/bin/env tsx
// Thin, deterministic CLI wrapper around kt_get_project_status
// (docs/ROADMAP.md's borrowed-from-CCPM T9.x item). kt_get_project_status
// is already a deterministic read query under the hood — this exposes the
// exact same service-layer call as a local script: no MCP round-trip, no
// running server, no LLM/agent required. Useful for a human checking status
// from a terminal, or a CI step that wants the same JSON without standing
// up the full MCP transport.
//
// Usage (local dev, via tsx):
//   npm run get-project-status -- <project_id>
//
// Usage (Docker / production runtime image): same constraint
// scripts/migrate.ts and scripts/rotate-encryption-key.ts already document
// — the runtime image has no `tsx` and only copies `dist`, not
// `scripts/*.ts`. Run the compiled output directly instead:
//   docker run --rm --env-file .env <image> \
//     node dist/scripts/get-project-status-cli.js <project_id>
//
// Prints the same JSON shape kt_get_project_status returns (docs/TRD.md
// §3.3) to stdout, pretty-printed. Exits non-zero with a plain-text error
// on stderr (project not found, invalid UUID, DB unreachable, etc.) rather
// than a stack trace.
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent } from '../src/config/load-dotenv.js';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { getProjectStatusService } from '../src/mcp/tools/get-project-status.js';
import { getProjectStatusInputSchema } from '../src/schemas/tools.js';

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const projectIdArg = process.argv[2];
  if (!projectIdArg) {
    throw new Error('usage: npm run get-project-status -- <project_id>');
  }
  // Reuses the same zod schema the MCP tool validates against (single
  // source of truth, src/schemas/tools.ts's header comment) so a malformed
  // id is rejected the same way here as it would be over MCP.
  const input = getProjectStatusInputSchema.parse({ project_id: projectIdArg });

  const config = loadConfig();
  const pool = createPool(config);
  try {
    const status = await getProjectStatusService(pool, config, input);
    console.log(JSON.stringify(status, null, 2));
  } finally {
    await pool.end();
  }
}

// Only auto-run when executed directly, not when imported — same guard as
// scripts/migrate.ts and scripts/rotate-encryption-key.ts.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error('get-project-status failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
