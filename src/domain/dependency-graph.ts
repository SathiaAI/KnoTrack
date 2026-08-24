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
