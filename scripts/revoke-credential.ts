#!/usr/bin/env tsx
// Revokes (permanently deletes) one project's stored GitHub or Linear adapter
// credential (docs/ROADMAP.md T5.4). This is an OPERATOR action, not an MCP
// tool: KnoTrack's mandated 14-tool contract has no revocation tool, and
// kt_register_project is the only credential-mutation tool (it can rotate a
// credential by re-registering, but never remove one). After this script runs,
// the project's adapter row is gone, so the next kt_sync_to_github /
// kt_sync_to_linear for that project fails with a clean "adapter not
// configured" CONFLICT (TRD §4.13/§4.14) rather than crashing or using a stale
// token — the credential is only ever decrypted per sync call, so nothing
// cached survives the delete.
//
// Usage (local dev, via tsx):
//   npm run revoke-credential -- <project_id> <github|linear>
//
// Usage (Docker / production runtime image): the runtime stage has no `tsx`
// (a devDependency) and copies only `dist`, not `scripts/*.ts` — same
// constraint scripts/migrate.ts and scripts/rotate-encryption-key.ts document.
// Run the compiled output directly:
//   docker run --rm --env-file .env <image> \
//     node dist/scripts/revoke-credential.js <project_id> <github|linear>
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent } from '../src/config/load-dotenv.js';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { deleteAdapterForProject } from '../src/db/queries/adapters.js';

function parseArgs(args: string[]): { projectId: string; type: 'github' | 'linear' } {
  const [projectId, type] = args;
  if (!projectId || (type !== 'github' && type !== 'linear')) {
    throw new Error('usage: revoke-credential <project_id> <github|linear>');
  }
  return { projectId, type };
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();
  const { projectId, type } = parseArgs(process.argv.slice(2));

  const pool = createPool(config);
  try {
    const revoked = await deleteAdapterForProject(pool, projectId, type);
    console.log(
      revoked
        ? `Revoked the ${type} credential for project ${projectId}. ` +
            `The next kt_sync_to_${type} for this project fails with ` +
            `"adapter not configured" until it is re-registered via kt_register_project.`
        : `No ${type} adapter was configured for project ${projectId}; nothing to revoke.`,
    );
  } finally {
    await pool.end();
  }
}

// Only auto-run when executed directly, not when imported by tests — same
// guard as scripts/migrate.ts and scripts/rotate-encryption-key.ts.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error('revoke-credential failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
