// kt_render_roadmap — docs/TRD.md §3.13, degradation rules in §6.3.
//
// A NOTE ON THE "5000ms WALL-CLOCK BUDGET" (style precedent:
// tool-helpers.ts's top-of-file comment): §6.3 describes both
// kt_check_drift and kt_render_roadmap as time-boxed "via a timer race".
// That literally works for kt_check_drift because its per-item rule
// evaluation is interleaved with real async work. It does *not* work here
// as a naive `Promise.race([render(), timeout()])`: Node is single-
// threaded, and a pending `setTimeout` callback can only run once the
// event loop is free — it cannot preempt a synchronous JS loop no matter
// how the enclosing Promise is structured. A `Promise.race` wrapped
// around a tight synchronous render would just run the render to
// completion (or run out of tracks) before the timer ever got a chance to
// fire, making the "race" dead code that looks like a safety net but does
// nothing.
//
// The only points this render actually yields to the event loop are its
// `await`s on each per-track item query. So the time budget here is
// instead a plain elapsed-time check performed between those awaits: we
// record `Date.now()` once at the start, and before fetching each
// subsequent track's items we compare elapsed time against the budget —
// if it's exceeded, we stop adding further tracks and mark the result
// truncated, the same outward signal as hitting a hard cap. This is
// necessarily best-effort (it can only ever stop *before* the next DB
// round-trip, never mid-query) and, being wall-clock/timing-dependent,
// is reasoned about here rather than asserted by a unit/integration
// test — the cap-based truncation path below is what's actually tested.
//
// There is also no separate KNOTRACK_ROADMAP_TIMEOUT_MS env var (checked
// src/config/env.ts — only driftScanTimeoutMs exists), so this
// deliberately reuses `config.driftScanTimeoutMs` as the budget rather
// than inventing an undocumented one, per §6.3's "same 5000ms wall-clock
// budget as drift scanning".
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { renderRoadmapInputSchema, type RenderRoadmapInput } from '../../schemas/tools.js';
import { findActiveProjectById } from '../../db/queries/projects.js';
import { getTrackSummariesForProject, getTrackDependencyEdges } from '../../db/queries/tracks.js';
import { listItemsByTrackCapped } from '../../db/queries/items.js';
import { withReadSnapshot } from '../../db/tx.js';
import { notFound } from '../errors.js';
import { runTool } from '../tool-helpers.js';
import { topoSort } from '../../domain/dependency-graph.js';
import {
  renderMarkdownRoadmap,
  renderMermaidRoadmap,
  buildTruncationNotice,
  appendTruncationNotice,
  type RoadmapItem,
} from '../../domain/roadmap-renderer.js';

export interface RenderRoadmapOutput extends Record<string, unknown> {
  content: string;
}

export async function renderRoadmapService(
  pool: Pool,
  config: Config,
  input: RenderRoadmapInput,
): Promise<RenderRoadmapOutput> {
  return withReadSnapshot(pool, async (client) => {
    const project = await findActiveProjectById(client, input.project_id);
    if (!project) {
      throw notFound('project not found', { project_id: input.project_id });
    }

    const startedAt = Date.now();
    const timeBudgetMs = config.driftScanTimeoutMs;

    // Sequential on this shared PoolClient — see get-project-status.ts's
    // comment on why these aren't run as a Promise.all.
    const allTracks = await getTrackSummariesForProject(client, input.project_id);
    const trackEdges = await getTrackDependencyEdges(client, input.project_id);

    const orderedTrackIds = topoSort(
      allTracks.map((t) => t.id),
      trackEdges,
    );
    const trackById = new Map(allTracks.map((t) => [t.id, t]));
    const orderedTracks = orderedTrackIds
      .map((id) => trackById.get(id))
      .filter((t): t is (typeof allTracks)[number] => t !== undefined);

    const candidateTracks = orderedTracks.slice(0, config.roadmapTrackCap);

    const itemsByTrackId = new Map<string, RoadmapItem[]>();
    const includedTracks: typeof candidateTracks = [];
    let itemCapHit = false;

    for (const track of candidateTracks) {
      // Checked before every per-track fetch (including the first) —
      // see this file's top-of-file comment for why this, not a
      // Promise.race, is the only place a time budget can actually bite.
      if (Date.now() - startedAt > timeBudgetMs) {
        break;
      }
      const rows = await listItemsByTrackCapped(
        client,
        track.id,
        config.roadmapItemPerTrackCap + 1,
      );
      if (rows.length > config.roadmapItemPerTrackCap) {
        itemCapHit = true;
      }
      itemsByTrackId.set(
        track.id,
        rows.slice(0, config.roadmapItemPerTrackCap).map((row) => ({
          title: row.title,
          status: row.status,
        })),
      );
      includedTracks.push(track);
    }

    // Covers both truncation causes uniformly: the track cap (fewer
    // candidateTracks than allTracks) and the time budget (the loop
    // above breaking before finishing candidateTracks) both show up here
    // as "we ended up with fewer included tracks than the project has".
    const trackTruncated = includedTracks.length < allTracks.length;

    let content: string;
    if (input.format === 'mermaid') {
      const includedIds = new Set(includedTracks.map((t) => t.id));
      const edges = trackEdges.filter(
        (edge) => includedIds.has(edge.from) && includedIds.has(edge.to),
      );
      content = renderMermaidRoadmap(includedTracks, edges);
    } else {
      content = renderMarkdownRoadmap(project.name, new Date(), includedTracks, itemsByTrackId);
    }

    if (trackTruncated || itemCapHit) {
      const clauses: string[] = [];
      if (trackTruncated) {
        clauses.push(`showing ${includedTracks.length} of ${allTracks.length} tracks`);
      }
      if (itemCapHit) {
        clauses.push(`some tracks omit items beyond the first ${config.roadmapItemPerTrackCap}`);
      }
      content = appendTruncationNotice(content, buildTruncationNotice(clauses));
    }

    return { content };
  });
}

export function registerRenderRoadmapTool(
  server: McpServer,
  pool: Pool,
  config: Config,
  logger: { error: (obj: unknown, msg?: string) => void },
): void {
  server.registerTool(
    'kt_render_roadmap',
    {
      title: 'Render roadmap',
      description: 'Generates a roadmap document (markdown or mermaid) from current DB state.',
      inputSchema: renderRoadmapInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (rawArgs: unknown) => {
      const input = renderRoadmapInputSchema.parse(rawArgs);
      return runTool(logger, 'kt_render_roadmap', () => renderRoadmapService(pool, config, input));
    },
  );
}
