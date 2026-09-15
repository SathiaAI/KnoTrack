// kt_create_track — docs/TRD.md §3.6.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { createTrackInputSchema, type CreateTrackInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import {
  getTrackDependencyEdges,
  getTrackEffectiveDoneForProject,
  insertTrack,
  insertTrackDependencies,
} from '../../db/queries/tracks.js';
import { wouldCreateCycle } from '../../domain/dependency-graph.js';
import { withTransaction } from '../../db/tx.js';
import { conflict, notFound, validationError } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface CreateTrackOutput extends Record<string, unknown> {
  track_id: string;
  /** T2.16: a listed depends_on track that isn't `effective_done` is a
   * warning, not a hard gate (final design doc §4 — settled at Paul's
   * 2026-09-08 sign-off). Present only when at least one such dependency
   * exists; absent (not an empty array) otherwise, so callers that only
   * check truthiness don't have to special-case an empty list. */
  warnings?: string[];
}

export async function createTrackService(
  pool: Pool,
  _config: Config,
  input: CreateTrackInput,
): Promise<CreateTrackOutput> {
  const dependsOn = Array.from(new Set(input.depends_on));

  return withTransaction(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const effectiveDoneByTrack = await getTrackEffectiveDoneForProject(client, input.project_id);
    const missing = dependsOn.filter((id) => !effectiveDoneByTrack.has(id));
    if (missing.length > 0) {
      throw notFound('one or more depends_on tracks do not exist in this project', {
        project_id: input.project_id,
        missing_track_ids: missing,
      });
    }

    // Cycle check across the project's existing track_dependencies plus
    // the proposed new node/edges (TRD §3.6's "systemic invariant"). Also
    // enforced at the database level by a BEFORE INSERT trigger on
    // track_dependencies (migrations/006_derived_track_status.sql) —
    // checked here too so a cycle is a clean 409 with a full picture of
    // the attempted edges, not a raw constraint-violation error from
    // whichever edge the trigger happens to reject first.
    const existingEdges = await getTrackDependencyEdges(client, input.project_id);
    // The new track doesn't have an id yet; use a sentinel that cannot
    // collide with a real UUID, then verify the cycle check below.
    const sentinel = '00000000-0000-0000-0000-000000000000';
    if (effectiveDoneByTrack.has(sentinel)) {
      throw validationError('internal sentinel collision — retry');
    }
    if (wouldCreateCycle(existingEdges, sentinel, dependsOn)) {
      throw conflict('dependency cycle detected', {
        project_id: input.project_id,
        depends_on: dependsOn,
      });
    }

    // T2.16: track status is derived at read time (migrations/
    // 006_derived_track_status.sql's track_readiness view), so there is
    // no initial status to compute or write here — the very next read of
    // this track correctly reports on_track/blocked from its actual
    // dependency state. The dependency-completeness check below is purely
    // advisory: it never blocks creation (settled by Paul, 2026-09-08 —
    // "warning, not a hard gate", since planning routinely creates tracks
    // that depend on unfinished work).
    const track = await insertTrack(client, {
      projectId: input.project_id,
      title: input.title,
      sourceDocRef: input.source_doc_ref,
    });

    await insertTrackDependencies(client, track.id, dependsOn);

    const unfinishedDeps = dependsOn.filter((id) => effectiveDoneByTrack.get(id) === false);
    const warnings =
      unfinishedDeps.length > 0
        ? [
            `depends_on includes ${unfinishedDeps.length} track(s) not yet fully complete ` +
              `(effective_done=false): ${unfinishedDeps.join(', ')}`,
          ]
        : undefined;

    return { track_id: track.id, ...(warnings ? { warnings } : {}) };
  });
}

export function registerCreateTrackTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_create_track',
    {
      title: 'Create track',
      description:
        'Creates a Track under a project, validating depends_on tracks and rejecting dependency cycles. ' +
        'A depends_on track that is not yet effective_done produces a warning, not an error.',
      inputSchema: createTrackInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = createTrackInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_create_track', () => createTrackService(pool, config, input));
    },
  );
}
