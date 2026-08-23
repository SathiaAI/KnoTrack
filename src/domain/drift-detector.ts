// The drift-flag rules (docs/TRD.md Appendix C / §6.3). Only the
// track-scoped SEQUENCE_SKIP-equivalent rule is implemented for real in
// this build, run by kt_record_session_summary (docs/TRD.md §3.9) right
// after it inserts the session's event row.
//
// Schema note: the real drift_flags.kind CHECK constraint
// (migrations/001_init.sql) only allows 'out_of_sequence' |
// 'orphan_file_change' — not TRD Appendix C's six flag_type values. Of
// those six, only SEQUENCE_SKIP has a direct match in the DB's allowed
// kinds ('out_of_sequence' — same semantics: an item finished while an
// earlier item in the same track is not done). The other five
// (STALE_TRACK, DEPENDENCY_GAP, UNDOCUMENTED_DECISION, ORPHAN_ITEM,
// SYNC_DRIFT) have no corresponding `kind` value the schema will accept,
// so they're left for kt_check_drift's future real implementation
// (out of scope here — see src/mcp/tools/check-drift.ts, a stub) rather
// than silently invented as extra allowed kind values on a migration this
// build must not alter.
import type { ItemRow } from '../db/queries/items.js';

export interface SequenceSkipFinding {
  itemId: string;
  detail: string;
}

/**
 * An item is "out of sequence" if it is `done` while at least one item
 * earlier in the same track's sequence is still `pending` or `blocked`.
 * Items must already be sorted by sequence_position ascending.
 */
export function findSequenceSkips(itemsBySequence: ItemRow[]): SequenceSkipFinding[] {
  const findings: SequenceSkipFinding[] = [];
  for (let i = 0; i < itemsBySequence.length; i += 1) {
    const item = itemsBySequence[i];
    if (!item || item.status !== 'done') continue;
    const earlierIncomplete = itemsBySequence
      .slice(0, i)
      .find((candidate) => candidate.status === 'pending' || candidate.status === 'blocked');
    if (earlierIncomplete) {
      findings.push({
        itemId: item.id,
        detail: `Item '${item.title}' (seq ${item.sequence_position}) is done while an earlier item '${earlierIncomplete.title}' (seq ${earlierIncomplete.sequence_position}) is still ${earlierIncomplete.status}.`,
      });
    }
  }
  return findings;
}
