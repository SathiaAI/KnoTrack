// Stub registrations for the 5 tools out of scope for this build. Each is
// registered with its real, TRD-accurate input schema (so `tools/list`
// reflects the full 14-tool surface and clients can still see the exact
// contract) but the handler always returns a clear "not yet implemented"
// isError result rather than doing any work.
//
// kt_list_tracks and kt_get_track moved out of this file to
// list-tracks.ts / get-track.ts once implemented (T2 build-out, first
// slice). kt_record_decision and kt_update_item_status moved out to
// record-decision.ts / update-item-status.ts once implemented (T2
// build-out, second slice) — see server.ts for their registration.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getNextStepsInputSchema,
  checkDriftInputSchema,
  renderRoadmapInputSchema,
  syncToGithubInputSchema,
  syncToLinearInputSchema,
} from '../../schemas/tools.js';
import { notImplementedResult } from '../tool-helpers.js';
import type { ZodTypeAny } from 'zod';

interface StubSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodTypeAny;
  annotations?: Record<string, boolean>;
}

const STUBS: StubSpec[] = [
  {
    name: 'kt_get_next_steps',
    title: 'Get next steps',
    description:
      'Advisory-only ranked list of unblocked items. Never assigns, claims, or locks anything.',
    inputSchema: getNextStepsInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'kt_check_drift',
    title: 'Check drift',
    description: 'Full, project-wide, synchronous drift scan.',
    inputSchema: checkDriftInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'kt_render_roadmap',
    title: 'Render roadmap',
    description: 'Generates a roadmap document (markdown or mermaid) from current DB state.',
    inputSchema: renderRoadmapInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'kt_sync_to_github',
    title: 'Sync to GitHub',
    description: 'Pushes a track/item to a linked GitHub Issue.',
    inputSchema: syncToGithubInputSchema,
  },
  {
    name: 'kt_sync_to_linear',
    title: 'Sync to Linear',
    description: 'Pushes a track/item to a linked Linear Issue.',
    inputSchema: syncToLinearInputSchema,
  },
];

export function registerStubTools(server: McpServer): void {
  for (const stub of STUBS) {
    server.registerTool(
      stub.name,
      {
        title: stub.title,
        description: `${stub.description} [NOT YET IMPLEMENTED in this build]`,
        inputSchema: stub.inputSchema,
        ...(stub.annotations ? { annotations: stub.annotations } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => notImplementedResult(stub.name),
    );
  }
}
