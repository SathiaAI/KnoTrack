// Markdown / mermaid string-building for kt_render_roadmap (TRD §3.13) —
// pure functions operating on already-fetched, already-ordered data (no
// DB access), matching dependency-graph.ts's pattern.

export interface RoadmapTrack {
  id: string;
  title: string;
  status: string;
}

export interface RoadmapItem {
  title: string;
  status: string;
}

export interface RoadmapEdge {
  /** Track id that depends on `to` — same direction as track_dependencies
   * everywhere else in the TRD. */
  from: string;
  to: string;
}

const CHECKBOX_BY_STATUS: Record<string, string> = {
  done: '[x]',
  pending: '[ ]',
  in_progress: '[~]',
  blocked: '[!]',
};

function checkbox(status: string): string {
  // Falls back to '[ ]' for any status outside the four the TRD defines —
  // defensive, not expected to ever trigger given items.status's CHECK
  // constraint.
  return CHECKBOX_BY_STATUS[status] ?? '[ ]';
}

/**
 * `# Roadmap: {name}` / `_Generated {iso}_`, then one `##` heading per
 * track (already in topological order — this function does not sort),
 * each followed by its items' checklist in the order given. Exact format
 * per TRD §3.13's example:
 *
 *   # Roadmap: KnoTrack Demo
 *   _Generated 2026-08-23T14:30:00.000Z_
 *
 *   ## Auth overhaul — on_track
 *   - [x] Add refresh endpoint
 *   - [ ] Add rotation tests
 */
export function renderMarkdownRoadmap(
  projectName: string,
  generatedAt: Date,
  tracks: RoadmapTrack[],
  itemsByTrackId: Map<string, RoadmapItem[]>,
): string {
  const header = `# Roadmap: ${projectName}\n_Generated ${generatedAt.toISOString()}_`;
  const sections = tracks.map((track) => {
    const items = itemsByTrackId.get(track.id) ?? [];
    const itemLines = items.map((item) => `- ${checkbox(item.status)} ${item.title}`);
    return [`## ${track.title} — ${track.status}`, ...itemLines].join('\n');
  });
  return [header, ...sections].join('\n\n') + '\n';
}

function sanitizeMermaidLabel(text: string): string {
  // TRD §3.13: "double quotes inside a title are replaced with single
  // quotes and newlines stripped, to keep the diagram syntactically
  // valid."
  return text.replace(/"/g, "'").replace(/\r?\n/g, '');
}

/** `t_` + the first 8 hex characters of the track UUID (the segment
 * before its first hyphen) — exactly TRD §3.13's example
 * (`8b2e1a10-...` -> `t_8b2e1a10`). Collisions are astronomically
 * unlikely for random UUIDs and deliberately not defended against
 * (TRD §3.13 / this build's judgment call). */
function mermaidNodeId(trackId: string): string {
  return `t_${trackId.split('-')[0]}`;
}

/**
 * `graph TD` of track-level dependencies: nodes first (in the same
 * topological order as the markdown renderer), then edges. `edges` is
 * expected pre-filtered to only reference tracks present in `tracks` —
 * this function does not filter.
 */
export function renderMermaidRoadmap(tracks: RoadmapTrack[], edges: RoadmapEdge[]): string {
  const lines: string[] = ['graph TD'];
  for (const track of tracks) {
    const label = sanitizeMermaidLabel(`${track.title} (${track.status})`);
    lines.push(`  ${mermaidNodeId(track.id)}["${label}"]`);
  }
  for (const edge of edges) {
    lines.push(`  ${mermaidNodeId(edge.from)} --> ${mermaidNodeId(edge.to)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Builds the §6.3 truncation notice from whichever clauses actually
 * apply, e.g. `showing 200 of 341 tracks` and/or `some tracks omit items
 * beyond the first 100`. The first clause continues the "Roadmap
 * truncated: ..." sentence lower-case; any further clause starts its own
 * capitalized sentence — matching TRD §6.3's example exactly when both
 * clauses apply:
 *   > Roadmap truncated: showing 200 of 341 tracks. Some tracks omit
 *   items beyond the first 100.
 */
export function buildTruncationNotice(clauses: string[]): string {
  const sentenceParts = clauses.map((clause, index) =>
    index === 0 ? clause : clause.charAt(0).toUpperCase() + clause.slice(1),
  );
  return `> Roadmap truncated: ${sentenceParts.join('. ')}.`;
}

/** Appends a truncation notice as trailing line(s) inside `content` —
 * the tool's only output field is `content` (a single string), so §6.3's
 * truncation signal has to be communicated inline rather than as a
 * separate field. */
export function appendTruncationNotice(content: string, notice: string): string {
  const withoutTrailingNewline = content.endsWith('\n') ? content : `${content}\n`;
  return `${withoutTrailingNewline}\n${notice}\n`;
}
