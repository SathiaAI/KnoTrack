// Shared precondition path for kt_sync_to_github / kt_sync_to_linear
// (T2.13 / T2.14 stub slice — docs/PRD.md §4.13/§4.14).
import type { Pool } from 'pg';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById } from '../../db/queries/tracks.js';
import { adapterConfigured } from '../../db/queries/adapters.js';
import { conflict, internalError, notFound } from '../errors.js';

export interface SyncOutput extends Record<string, unknown> {
  ok: true;
}

export interface SyncInput {
  project_id: string;
  track_id: string;
}

/**
 * Validates the project and track exist (project-scoped track lookup, so
 * a `track_id` from another project is a 404, never a cross-project
 * leak), then checks the adapter precondition:
 *   - no adapter row for (project, type) -> CONFLICT "<type> adapter not
 *     configured" (the caller must configure credentials first; PRD
 *     §4.13 acceptance). Makes no outbound HTTP call.
 *   - an adapter row exists -> the real GitHub/Linear push is not built
 *     in this build, so this returns a clear "<type> sync is not
 *     available in this build" INTERNAL_ERROR rather than a false success
 *     or a misleading "not configured". This state is only reachable via
 *     fixtures / manual SQL today (no MCP tool provisions an adapter
 *     until T5); the T5.2 / T5.3 API path replaces this branch and the
 *     success return below.
 */
export async function syncAdapterStub(
  pool: Pool,
  type: 'github' | 'linear',
  input: SyncInput,
): Promise<SyncOutput> {
  const project = await findActiveProjectById(pool, input.project_id);
  if (!project) {
    throw notFound('project not found', { project_id: input.project_id });
  }
  const track = await findTrackById(pool, input.project_id, input.track_id);
  if (!track) {
    throw notFound('track not found in this project', {
      project_id: input.project_id,
      track_id: input.track_id,
    });
  }
  const configured = await adapterConfigured(pool, input.project_id, type);
  if (!configured) {
    throw conflict(`${type} adapter not configured`, {
      project_id: input.project_id,
      adapter: type,
    });
  }
  throw internalError(`${type} sync is not available in this build`, {
    project_id: input.project_id,
    track_id: input.track_id,
    adapter: type,
  });
}
