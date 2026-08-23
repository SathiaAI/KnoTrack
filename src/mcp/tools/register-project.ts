// kt_register_project — docs/TRD.md §3.2.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { registerProjectInputSchema, type RegisterProjectInput } from '../../schemas/tools.js';
import { upsertProjectBySourceRef } from '../../db/queries/projects.js';
import { upsertAdapter } from '../../db/queries/adapters.js';
import { encryptCredential } from '../../crypto/credential-cipher.js';
import { withTransaction } from '../../db/tx.js';
import { internalError } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface RegisterProjectOutput extends Record<string, unknown> {
  project_id: string;
}

/**
 * Upsert semantics (TRD §3.2): uniqueness is on (source_type, source_ref).
 * Calling again with the same pair updates name/adapters on the existing
 * row and returns the *original* project_id — never a duplicate, never a
 * 409.
 */
export async function registerProjectService(
  pool: Pool,
  config: Config,
  input: RegisterProjectInput,
  // adversarial-review P2: the catch blocks below used to put the raw
  // driver-error message on `details.cause`, which runTool then serializes
  // verbatim into the client-facing envelope — leaking DB/driver internals
  // through what TRD §3.1 documents as a generic 500. Defaulting to
  // `console` keeps every existing call site working unchanged while
  // registerProjectTool passes the real request logger.
  logger: { error: (obj: unknown, msg?: string) => void } = console,
): Promise<RegisterProjectOutput> {
  return withTransaction(pool, async (client) => {
    // Atomic upsert on (source_type, source_ref) — see
    // upsertProjectBySourceRef's doc comment (adversarial-review
    // correctness-3: this used to be a separate find-then-insert, racy
    // under concurrent calls with the same source identity).
    const project = await upsertProjectBySourceRef(client, {
      name: input.name,
      sourceType: input.source_type,
      sourceRef: input.source_ref,
    });
    const projectId = project.id;

    if (input.adapters?.github) {
      try {
        const encrypted = encryptCredential(
          input.adapters.github.personal_access_token,
          config.encryptionKey,
        );
        await upsertAdapter(client, {
          projectId,
          type: 'github',
          encryptedCredential: encrypted,
          config: {
            repo:
              input.adapters.github.repo ??
              (input.source_type === 'github' ? input.source_ref : undefined),
            connected: true,
          },
        });
      } catch (cause) {
        logger.error({ err: cause }, 'failed to store github adapter credential');
        throw internalError('failed to store github adapter credential');
      }
    }

    if (input.adapters?.linear) {
      try {
        const encrypted = encryptCredential(input.adapters.linear.api_key, config.encryptionKey);
        await upsertAdapter(client, {
          projectId,
          type: 'linear',
          encryptedCredential: encrypted,
          config: {
            team_id: input.adapters.linear.team_id,
            connected: true,
          },
        });
      } catch (cause) {
        logger.error({ err: cause }, 'failed to store linear adapter credential');
        throw internalError('failed to store linear adapter credential');
      }
    }

    return { project_id: projectId };
  });
}

export function registerProjectTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_register_project',
    {
      title: 'Register project',
      description:
        'Registers a project, or upserts one on (source_type, source_ref). This is the only mechanism to add/rotate adapter credentials after initial registration.',
      inputSchema: registerProjectInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = rawArgs as RegisterProjectInput;
      return runTool(logger, 'kt_register_project', () =>
        registerProjectService(pool, config, input, logger),
      );
    },
  );
}
