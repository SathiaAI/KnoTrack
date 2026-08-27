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
  const inputIndex = new Map<string, number>();
  allNodeIds.forEach((id, index) => inputIndex.set(id, index));

  // Kahn's algorithm over the reversed edge direction, run in O((V + E)
  // log V) via a binary min-heap keyed by original input position — NOT
  // the naive O(V^2) "rescan `remaining` for an eligible node every
  // iteration" this replaced (adversarial-review P2: that approach makes
  // even an edge-free graph of tens of thousands of tracks quadratic,
  // running synchronously and unbounded ahead of render-roadmap.ts's own
  // time-budget check). `prereqCount` tracks each node's number of
  // not-yet-emitted prerequisites; `dependentsOf` is the reverse index
  // used to decrement it as prerequisites get emitted. The heap always
  // holds exactly the nodes currently eligible (prereqCount === 0) not
  // yet emitted, so popping the minimum input-index each time reproduces
  // the same "input order among simultaneously-eligible nodes" tie-break
  // the old scan-based version had, just without rescanning everything.
  const prereqCount = new Map<string, number>();
  const dependentsOf = new Map<string, string[]>();
  for (const id of allNodeIds) {
    prereqCount.set(id, 0);
    dependentsOf.set(id, []);
  }
  const seenEdge = new Set<string>();
  for (const edge of edges) {
    // Ignore edges referencing a node outside allNodeIds (defensive —
    // callers are expected to pass a consistent node/edge set, but this
    // keeps the function total rather than throwing on a mismatch) and
    // de-duplicate parallel edges (same pair seen twice would otherwise
    // double-count prereqCount and require two decrements to clear it).
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    const key = `${edge.from}\0${edge.to}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    prereqCount.set(edge.from, prereqCount.get(edge.from)! + 1);
    dependentsOf.get(edge.to)!.push(edge.from);
  }

  // Minimal binary min-heap of node ids, ordered by inputIndex. Small and
  // local to this function rather than a shared utility — nothing else
  // in this codebase needs a heap.
  const heap: string[] = [];
  const heapKey = (id: string): number => inputIndex.get(id)!;
  const heapPush = (id: string): void => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapKey(heap[parent]!) <= heapKey(heap[i]!)) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const heapPop = (): string => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < heap.length && heapKey(heap[left]!) < heapKey(heap[smallest]!)) smallest = left;
        if (right < heap.length && heapKey(heap[right]!) < heapKey(heap[smallest]!))
          smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!];
        i = smallest;
      }
    }
    return top;
  };

  for (const id of allNodeIds) {
    if (prereqCount.get(id) === 0) heapPush(id);
  }

  const emitted = new Set<string>();
  const result: string[] = [];
  while (heap.length > 0) {
    const id = heapPop();
    result.push(id);
    emitted.add(id);
    for (const dependent of dependentsOf.get(id)!) {
      const remaining = prereqCount.get(dependent)! - 1;
      prereqCount.set(dependent, remaining);
      if (remaining === 0) heapPush(dependent);
    }
  }

  if (emitted.size < allNodeIds.length) {
    // Cycle fallback: some nodes never reached prereqCount === 0, meaning
    // every one of them has an un-emitted prerequisite that's also stuck
    // — a cycle. Append the rest in input order, same as before.
    for (const id of allNodeIds) {
      if (!emitted.has(id)) result.push(id);
    }
  }

  return result;
}
