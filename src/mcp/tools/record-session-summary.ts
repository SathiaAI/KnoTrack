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
  insertDriftFlagIfNotOpen,
  listOpenFlagsForTrack,
  resolveDriftFlags,
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
  // Defaulting to `console` keeps every existing call site working
  // unchanged while registerRecordSessionSummaryTool passes the real
  // request logger (used below to note a skipped drift scan).
  logger: { error: (obj: unknown, msg?: string) => void } = console,
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
    // adversarial-review reliability-4 / P1: findSequenceSkips is O(n^2)
    // in the track's item count (a nested scan for the earliest
    // incomplete item per done item). KNOTRACK_DRIFT_SCAN_ITEM_CAP bounds
    // this — but it's documented (TRD §6.3/§7) as a limit on
    // kt_check_drift's scan, not a reason to refuse an otherwise-valid
    // kt_record_session_summary write. A prior fix enforced it by
    // throwing and rolling back the whole call (including the event
    // insert above) once a track outgrew the cap, which meant a track's
    // session summaries silently stopped being recordable at all past
    // that size. The re-check is a best-effort side effect of this write,
    // not its purpose: past the cap, skip the scan (log it) and still let
    // the event commit.
    const trackItems = await listItemsByTrack(client, track.id);
    const raised: RecordSessionSummaryOutput['drift_flags_raised'] = [];
    if (trackItems.length > config.driftScanItemCap) {
      logger.error(
        { track_id: track.id, item_count: trackItems.length, cap: config.driftScanItemCap },
        'kt_record_session_summary: track exceeds driftScanItemCap — skipping the scoped drift re-check for this call, event still recorded',
      );
    } else {
      const findings = findSequenceSkips(trackItems);
      const findingItemIds = new Set(findings.map((f) => f.itemId));

      // adversarial-review P1 (resolve cleared flags): reconcile this
      // track's existing open flags against the current findings first —
      // any item that had an open flag but no longer matches a finding
      // (e.g. the earlier item it was blocked on is now also done) has
      // had its condition clear, so its flag gets resolved_at set. Read
      // before raising new ones below so an item's open-ness reflects
      // this scan, not a stale one.
      const openFlags = await listOpenFlagsForTrack(client, track.id, 'out_of_sequence');
      const openItemIds = new Set(
        openFlags.map((f) => f.item_id).filter((id): id is string => id !== null),
      );
      const toResolve = openFlags
        .filter((f) => f.item_id !== null && !findingItemIds.has(f.item_id))
        .map((f) => f.id);
      if (toResolve.length > 0) {
        await resolveDriftFlags(client, toResolve);
      }

      // adversarial-review P1 (serialize open-flag creation): insertion
      // is an atomic INSERT ... ON CONFLICT DO NOTHING against the DB's
      // uq_drift_flags_open_item_kind partial unique index
      // (migrations/003), not a separate check-then-insert — two
      // concurrent calls raising a flag for the same item can no longer
      // both succeed.
      for (const finding of findings) {
        if (openItemIds.has(finding.itemId)) continue;
        const flagRow = await insertDriftFlagIfNotOpen(client, {
          projectId: input.project_id,
          trackId: track.id,
          itemId: finding.itemId,
          kind: 'out_of_sequence',
          detail: { message: finding.detail },
        });
        if (!flagRow) continue;
        const view = driftFlagToView(flagRow);
        raised.push({
          flag_id: view.flag_id,
          flag_type: view.flag_type,
          severity: view.severity,
          detail: view.detail,
        });
      }
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
        recordSessionSummaryService(pool, config, input, logger),
      );
    },
  );
}
