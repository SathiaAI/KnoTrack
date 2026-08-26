// Topo-sort + cycle detection, shared by kt_create_track and
// kt_create_item (TRD §3.6, §3.7). An edge {from, to} means "from depends
// on to" — matching the depends_on_track_id / depends_on_item_id
// direction used everywhere else in the TRD.

export interface Edge {
  from: string;
  to: string;
}

/**
 * Returns true if the directed graph described by `edges` contains a
 * cycle reachable from any node. Uses a standard three-color DFS
 * (white/gray/black) so it runs in O(V + E) regardless of how the edges
 * are ordered.
 */
export function hasCycle(edges: Edge[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) {
      list.push(edge.to);
    } else {
      adjacency.set(edge.from, [edge.to]);
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, []);
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of adjacency.keys()) {
    color.set(node, WHITE);
  }

  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) {
        return true; // back edge -> cycle
      }
      if (nextColor === WHITE && visit(next)) {
        return true;
      }
    }
    color.set(node, BLACK);
    return false;
  };

  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE && visit(node)) {
      return true;
    }
  }
  return false;
}

/**
 * Convenience wrapper for the create-time check: given the existing
 * dependency edges already in the DB for this scope (project's tracks, or
 * one track's items), plus the proposed new node and its (de-duplicated)
 * depends_on list, would inserting those new edges create a cycle?
 */
export function wouldCreateCycle(
  existingEdges: Edge[],
  newNodeId: string,
  dependsOn: string[],
): boolean {
  const deduped = Array.from(new Set(dependsOn));
  const proposedEdges: Edge[] = deduped.map((to) => ({ from: newNodeId, to }));
  return hasCycle([...existingEdges, ...proposedEdges]);
}

/**
 * Topological ordering for kt_render_roadmap (TRD §3.13): returns
 * `allNodeIds` reordered so that for every edge {from, to} ("from depends
 * on to"), `to` appears before `from` — prerequisites first, dependents
 * last. This is Kahn's algorithm run over the *reversed* edge direction:
 * a node becomes eligible to emit once every node it depends on has
 * already been emitted, so we repeatedly scan for the earliest-ordered
 * still-eligible node rather than tracking in-degrees directly.
 *
 * Ties among simultaneously-eligible nodes are broken by `allNodeIds`'s
 * own input order (a stable pick of "first eligible node encountered").
 * Callers that want a specific tie-break (e.g. created_at ascending, this
 * repo's existing default track ordering — see
 * `listTracksWithItemCounts`'s `ORDER BY t.created_at ASC`) should
 * pre-sort `allNodeIds` before calling.
 *
 * Defends against a cycle that should be structurally impossible —
 * `wouldCreateCycle` above already prevents one from ever being written
 * at create-track time — by appending whatever nodes are left over, in
 * their original input order, rather than throwing. kt_render_roadmap is
 * a read-only reporting tool; it should degrade rather than hard-fail on
 * a pre-existing data invariant violation it has no way to repair.
 */
export function topoSort(allNodeIds: string[], edges: Edge[]): string[] {
  const nodeSet = new Set(allNodeIds);
  const prereqsOf = new Map<string, Set<string>>();
  for (const id of allNodeIds) {
    prereqsOf.set(id, new Set());
  }
  for (const edge of edges) {
    // Ignore edges referencing a node outside allNodeIds (defensive —
    // callers are expected to pass a consistent node/edge set, but this
    // keeps the function total rather than throwing on a mismatch).
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    prereqsOf.get(edge.from)!.add(edge.to);
  }

  const emitted = new Set<string>();
  const result: string[] = [];
  const remaining = [...allNodeIds];

  while (remaining.length > 0) {
    const eligibleIndex = remaining.findIndex((id) => {
      const prereqs = prereqsOf.get(id)!;
      for (const prereq of prereqs) {
        if (!emitted.has(prereq)) return false;
      }
      return true;
    });

    if (eligibleIndex === -1) {
      // Cycle fallback: nothing in `remaining` is eligible, meaning
      // every remaining node has an un-emitted prerequisite also stuck
      // in `remaining` — a cycle. Append the rest in input order.
      result.push(...remaining);
      break;
    }

    const [id] = remaining.splice(eligibleIndex, 1);
    result.push(id!);
    emitted.add(id!);
  }

  return result;
}
