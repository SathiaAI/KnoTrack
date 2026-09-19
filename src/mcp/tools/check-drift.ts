// kt_check_drift — docs/PRD.md §4.11 (T2.11 stub slice).
//
// This build ships the stub slice: it validates the project exists and
// returns a well-formed but empty scan result carrying
// `note: "no heuristics configured"`, rather than an error. The real
// drift heuristics that populate `flags` land in T6.4 (which replaces
// this note-only body); `kt_record_session_summary`'s scoped per-track
// re-check already raises SEQUENCE_SKIP flags today.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { checkDriftInputSchema, type CheckDriftInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { countTracksForProject } from '../../db/queries/tracks.js';
import { notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface CheckDriftOutput extends Record<string, unknown> {
  flags: unknown[];
  truncated: boolean;
  scanned_track_count: number;
  total_track_count: number;
  scan_duration_ms: number;
  note: string;
}

export async function checkDriftService(
  pool: Pool,
  _config: Config,
  input: CheckDriftInput,
): Promise<CheckDriftOutput> {
  const start = Date.now();
  const project = await findActiveProjectById(pool, input.project_id);
  if (!project) {
    throw notFound('project not found', { project_id: input.project_id });
  }
  // No heuristics run in this build, so nothing is scanned and no flags
  // are raised. total_track_count still reflects reality so a client can
  // see the scan scope; scanned_track_count stays 0 to make the
  // not-actually-scanned state explicit (not a clean bill of health). Use
  // a plain COUNT(*) — not a track_readiness join — so this empty stub
  // scan can't do an uncapped full-project computation (Codex PR #22).
  const totalTrackCount = await countTracksForProject(pool, input.project_id);
  return {
    flags: [],
    truncated: false,
    scanned_track_count: 0,
    total_track_count: totalTrackCount,
    scan_duration_ms: Date.now() - start,
    note: 'no heuristics configured',
  };
}

export function registerCheckDriftTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_check_drift',
    {
      title: 'Check drift',
      description:
        'Full, project-wide, synchronous drift scan. Returns an empty result until drift heuristics are configured in a later build.',
      inputSchema: checkDriftInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (rawArgs: unknown) => {
      const input = checkDriftInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_check_drift', () => checkDriftService(pool, config, input));
    },
  );
}
