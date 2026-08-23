// kt_record_session_summary — docs/TRD.md §3.9.
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import {
  recordSessionSummaryInputSchema,
  type RecordSessionSummaryInput,
} from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { findTrackById } from '../../db/queries/tracks.js';
import { getItemsByIds, listItemsByTrack } from '../../db/queries/items.js';
import { insertEvent } from '../../db/queries/events.js';
import {
  hasOpenFlagForItem,
  insertDriftFlag,
  driftFlagToView,
} from '../../db/queries/drift-flags.js';
import { findSequenceSkips } from '../../domain/drift-detector.js';
import { withTransaction } from '../../db/tx.js';
import { notFound, validationError } from '../errors.js';
import { runTool } from '../tool-helpers.js';

export interface RecordSessionSummaryOutput extends Record<string, unknown> {
  event_id: string;
  drift_flags_raised: Array<{
    flag_id: string;
    flag_type: string;
    severity: string;
    detail: string;
  }>;
}

export async function recordSessionSummaryService(
  pool: Pool,
  config: Config,
  input: RecordSessionSummaryInput,
): Promise<RecordSessionSummaryOutput> {
  const itemsTouched = Array.from(new Set(input.items_touched));

  return withTransaction(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const track = await findTrackById(client, input.project_id, input.track_id);
    if (!track) {
      throw notFound('track not found in this project', {
        project_id: input.project_id,
        track_id: input.track_id,
      });
    }

    if (itemsTouched.length > 0) {
      const foundItems = await getItemsByIds(client, itemsTouched);
      const missing = itemsTouched.filter((id) => !foundItems.has(id));
      if (missing.length > 0) {
        throw notFound('one or more items_touched ids do not exist as items at all', {
          missing_item_ids: missing,
        });
      }
      const wrongTrack = itemsTouched.filter((id) => foundItems.get(id)?.track_id !== track.id);
      if (wrongTrack.length > 0) {
        throw validationError('items_touched ids must belong to track_id', {
          wrong_track_item_ids: wrongTrack,
          track_id: track.id,
        });
      }
    }

    const event = await insertEvent(client, {
      projectId: input.project_id,
      trackId: track.id,
      summaryText: input.summary_text,
      filesTouched: input.files_touched,
      itemsTouched,
    });

    // Scoped drift re-check (TRD §3.9): this track only, not the whole
    // project. See src/domain/drift-detector.ts's header comment for why
    // only the 'out_of_sequence' kind is checked here.
    //
    // adversarial-review reliability-4: findSequenceSkips is O(n^2) in the
    // track's item count (a nested scan for the earliest incomplete item
    // per done item). KNOTRACK_DRIFT_SCAN_ITEM_CAP exists precisely to
    // bound this, but was declared in config and never enforced anywhere.
    // Reject oversized tracks defensively rather than let a runaway scan
    // consume CPU/memory inside an open transaction.
    const trackItems = await listItemsByTrack(client, track.id);
    if (trackItems.length > config.driftScanItemCap) {
      throw validationError(
        'track has too many items for the drift re-check to scan safely',
        { track_id: track.id, item_count: trackItems.length, cap: config.driftScanItemCap },
      );
    }
    const findings = findSequenceSkips(trackItems);
    const raised: RecordSessionSummaryOutput['drift_flags_raised'] = [];
    for (const finding of findings) {
      const alreadyOpen = await hasOpenFlagForItem(client, finding.itemId, 'out_of_sequence');
      if (alreadyOpen) continue;
      const flagRow = await insertDriftFlag(client, {
        projectId: input.project_id,
        trackId: track.id,
        itemId: finding.itemId,
        kind: 'out_of_sequence',
        detail: { message: finding.detail },
      });
      const view = driftFlagToView(flagRow);
      raised.push({
        flag_id: view.flag_id,
        flag_type: view.flag_type,
        severity: view.severity,
        detail: view.detail,
      });
    }

    return {
      event_id: event.id,
      drift_flags_raised: raised,
    };
  });
}

export function registerRecordSessionSummaryTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_record_session_summary',
    {
      title: 'Record session summary',
      description:
        "Appends a session's summary plus files/items touched to a track's event log, then re-runs the scoped drift re-check for that track.",
      inputSchema: recordSessionSummaryInputSchema,
    },
    async (rawArgs: unknown) => {
      const input = rawArgs as RecordSessionSummaryInput;
      return runTool(logger, 'kt_record_session_summary', () =>
        recordSessionSummaryService(pool, config, input),
      );
    },
  );
}
