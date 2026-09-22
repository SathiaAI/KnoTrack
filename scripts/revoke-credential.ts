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
// This deletes KnoTrack's STORED COPY only. It does NOT revoke the token at the
// provider — you must ALSO revoke the PAT at GitHub / the API key at Linear to
// invalidate it there.
//
// Usage (local dev, via tsx) — a bare run PREVIEWS and does nothing; add --yes
// to actually delete (a fat-finger guard, matching rotate-encryption-key's care):
//   npm run revoke-credential -- <project_id> <github|linear>          # preview
//   npm run revoke-credential -- <project_id> <github|linear> --yes    # delete
//
// Usage (Docker / production runtime image): the runtime stage has no `tsx`
// (a devDependency) and copies only `dist`, not `scripts/*.ts` — same
// constraint scripts/migrate.ts and scripts/rotate-encryption-key.ts document.
//   docker run --rm --env-file .env <image> \
//     node dist/scripts/revoke-credential.js <project_id> <github|linear> --yes
import { fileURLToPath } from 'node:url';
import { loadDotEnvIfPresent } from '../src/config/load-dotenv.js';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { adapterConfigured, deleteAdapterForProject } from '../src/db/queries/adapters.js';

export interface RevokeArgs {
  projectId: string;
  type: 'github' | 'linear';
  confirmed: boolean;
}

/** Parses `<project_id> <github|linear> [--yes]` (flag order-independent).
 * Throws on a missing project id or an out-of-allowlist type, so the caller
 * exits non-zero on malformed input. */
export function parseArgs(args: string[]): RevokeArgs {
  const confirmed = args.includes('--yes');
  const positional = args.filter((a) => a !== '--yes');
  const [projectId, type] = positional;
  if (!projectId || (type !== 'github' && type !== 'linear')) {
    throw new Error('usage: revoke-credential <project_id> <github|linear> [--yes]');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error(`invalid project_id (expected a UUID): ${projectId}`);
  }
  return { projectId, type, confirmed };
}

function providerName(type: 'github' | 'linear'): string {
  return type === 'github' ? 'GitHub' : 'Linear';
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();
  const { projectId, type, confirmed } = parseArgs(process.argv.slice(2));

  const pool = createPool(config);
  try {
    const exists = await adapterConfigured(pool, projectId, type);

    // Dry-run preview unless --yes: show the target and refuse to delete, so an
    // accidental invocation never destroys a credential (frontier panel, T5.4).
    if (!confirmed) {
      console.log(
        `PREVIEW — would revoke the ${type} credential for project ${projectId} ` +
          `(adapter currently ${exists ? 'CONFIGURED' : 'not configured'}).\n` +
          `This removes KnoTrack's stored copy ONLY — you must also revoke the token at ` +
          `${providerName(type)} to invalidate it there.\n` +
          `Re-run with --yes to proceed: revoke-credential ${projectId} ${type} --yes`,
      );
      return;
    }

    console.log(
      `Revoking the ${type} credential for project ${projectId} ` +
        `(currently ${exists ? 'CONFIGURED' : 'not configured'})...`,
    );
    const deletedId = await deleteAdapterForProject(pool, projectId, type);
    const operator = process.env.SUDO_USER ?? process.env.USER ?? 'unknown';
    const audit =
      `[${new Date().toISOString()}] revoke-credential operator=${operator} ` +
      `project=${projectId} type=${type} adapter_id=${deletedId ?? '-'} ` +
      `rows_deleted=${deletedId ? 1 : 0}`;
    console.log(
      deletedId
        ? `${audit}\nRevoked. Any sync that STARTS after this fails with ` +
            `"adapter not configured" until re-registered via kt_register_project (a sync ` +
            `already in flight may finish with the old token — it took its copy before the delete). ` +
            `Remember to also revoke the token at ${providerName(type)}.`
        : `${audit}\nNo ${type} adapter was configured for project ${projectId}; nothing to revoke.`,
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
