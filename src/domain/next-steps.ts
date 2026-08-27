// Recommendation ranking for kt_get_next_steps (TRD §3.8) — a pure
// function, no DB access, matching dependency-graph.ts's pattern of
// domain logic that's unit-tested in isolation from the query layer.

export interface NextStepsItemInput {
  id: string;
  track_id: string;
  title: string;
  sequence_position: number;
  created_at: Date;
  /** This item's own depends_on_item_ids — already resolved by the
   * caller's query, so this function never needs to look anything up
   * beyond the two maps below. */
  dependsOnItemIds: string[];
}

export interface NextStepsTrackInput {
  title: string;
  status: string;
}

export interface RecommendedItem {
  item_id: string;
  title: string;
  track_id: string;
  track_title: string;
  reason: string;
}

/**
 * Track-status sort priority for TRD §3.8 step 4. The TRD only defines
 * relative order for `on_track` vs `pivot_pending` among survivors
 * ("track status priority (on_track before pivot_pending)"). A survivor's
 * track can never actually be `blocked` (step 3 already drops those), and
 * realistically shouldn't be `done` while still holding a pending item —
 * but rather than leave that case unspecified, any other/unexpected
 * status sorts after `pivot_pending` as a defensive, deterministic
 * default. This is a judgment call, not something the TRD spells out.
 */
function trackStatusPriority(status: string): number {
  if (status === 'on_track') return 0;
  if (status === 'pivot_pending') return 1;
  return 2;
}

/**
 * TRD §3.8's full algorithm, steps 1-6:
 *   1. `pendingItems` is assumed pre-filtered to status = 'pending' by the
 *      caller's query.
 *   2. Keep only items where every depends_on_item_id is `done` (or the
 *      item has no dependencies) — via `itemStatusById`.
 *   3. Drop items whose track has stored status 'blocked'.
 *   4. Sort by track status priority, then sequence_position ascending,
 *      then created_at ascending.
 *   5. Take the top `limit`.
 *   6. Build each survivor's `reason` from the fixed template.
 */
export function rankNextSteps(
  pendingItems: NextStepsItemInput[],
  tracksById: Map<string, NextStepsTrackInput>,
  itemStatusById: Map<string, string>,
  limit: number,
): RecommendedItem[] {
  const survivors = pendingItems.filter((item) => {
    const track = tracksById.get(item.track_id);
    if (!track || track.status === 'blocked') return false;
    return item.dependsOnItemIds.every((depId) => itemStatusById.get(depId) === 'done');
  });

  survivors.sort((a, b) => {
    const trackA = tracksById.get(a.track_id);
    const trackB = tracksById.get(b.track_id);
    const priorityDiff =
      trackStatusPriority(trackA?.status ?? '') - trackStatusPriority(trackB?.status ?? '');
    if (priorityDiff !== 0) return priorityDiff;
    if (a.sequence_position !== b.sequence_position) {
      return a.sequence_position - b.sequence_position;
    }
    if (a.created_at.getTime() !== b.created_at.getTime()) {
      return a.created_at.getTime() - b.created_at.getTime();
    }
    // adversarial-review P2: track priority, sequence_position, and
    // created_at can all tie (e.g. two items created in the same
    // millisecond), and the caller's query defines no row order beyond
    // that — without a final deterministic key, JS's stable sort would
    // just preserve whatever order Postgres happened to return the rows
    // in, which isn't guaranteed stable across calls. `id` is unique, so
    // this always fully resolves the ordering.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return survivors.slice(0, limit).map((item) => {
    const track = tracksById.get(item.track_id);
    const trackTitle = track?.title ?? '';
    const n = item.dependsOnItemIds.length;
    // TRD §3.8's prose template literally says "All {n} dependencies
    // complete" (always plural), but its own worked example shows
    // singular for n=1 ("All 1 dependency complete..."). Treating the
    // concrete example as the authoritative wire format (same call made
    // for kt_update_item_status's "1 unmet dependency" message elsewhere
    // in this build) rather than the imprecise prose.
    const reason =
      n === 0
        ? `No dependencies — ready to start in track "${trackTitle}".`
        : `All ${n} ${n === 1 ? 'dependency' : 'dependencies'} complete — next up in track "${trackTitle}".`;
    return {
      item_id: item.id,
      title: item.title,
      track_id: item.track_id,
      track_title: trackTitle,
      reason,
    };
  });
}
