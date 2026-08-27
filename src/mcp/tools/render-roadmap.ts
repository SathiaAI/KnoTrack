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
// This render yields to the event loop at two kinds of points: the
// `await`s between per-track item queries, AND during each individual
// query's own round-trip (which can itself run long against a slow or
// overloaded database — adversarial-review P1: an earlier version only
// checked elapsed time *between* queries, so a single slow query could
// run all the way to the driver's default 30s statement timeout before
// this function ever got a chance to notice the budget was blown,
// defeating the "never turn a large project into a hard failure"
// guarantee for exactly the case it exists to cover). To actually bound
// that, this sets Postgres's own `statement_timeout` (via `SET LOCAL`,
// scoped to this transaction) to whatever's left of the budget before
// every query that could plausibly be slow, and treats Postgres's
// resulting `query_canceled` (SQLSTATE `57014`) error as "hit the time
// budget" rather than letting it propagate as a 500 — the same outward
// truncated-result signal as running out of time between queries. This
// is still necessarily best-effort (a query can't be interrupted
// mid-row-scan any *faster* than Postgres's own timeout check runs), but
// it means the worst case is bounded by the budget instead of by the
// driver's unrelated default.
//
// The cap-based truncation path is what's actually asserted by
// integration tests below; the time-budget path (both the between-query
// check and the statement_timeout cancellation) is inherently
// timing-dependent and is reasoned about here rather than asserted.
//
// There is also no separate KNOTRACK_ROADMAP_TIMEOUT_MS env var (checked
// src/config/env.ts — only driftScanTimeoutMs exists), so this
// deliberately reuses `config.driftScanTimeoutMs` as the budget rather
// than inventing an undocumented one, per §6.3's "same 5000ms wall-clock
// budget as drift scanning".
import type { Pool, PoolClient } from 'pg';
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

/** Postgres's SQLSTATE for a statement canceled by `statement_timeout`
 * (or `pg_cancel_backend`). node-postgres surfaces this as a plain
 * `DatabaseError` with a `.code` string, not a distinct error class.
 * Exported for a deterministic unit test of `isQueryCanceled` below —
 * the timeout behavior itself is timing-dependent and not asserted by a
 * test, per this file's top-of-file comment, but the error-classifying
 * predicate is pure and cheap to test directly. */
export const QUERY_CANCELED_SQLSTATE = '57014';

export function isQueryCanceled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === QUERY_CANCELED_SQLSTATE
  );
}

/** Sets this transaction's remaining statement_timeout to whatever's left
 * of the overall budget, floored at 1ms (0/negative would mean "no
 * timeout" to Postgres, the opposite of what's intended — but callers
 * are expected to have already checked `remaining > 0` before deciding
 * to issue another query at all, so this floor is a last-resort
 * safeguard, not the primary guard). `SET LOCAL` takes a plain integer,
 * not a bind parameter, but the value here is always a number this
 * function computed, never user input. */
async function setRemainingStatementTimeout(
  client: PoolClient,
  startedAt: number,
  budgetMs: number,
): Promise<void> {
  const remaining = Math.max(1, budgetMs - (Date.now() - startedAt));
  await client.query(`SET LOCAL statement_timeout = ${Math.floor(remaining)}`);
}

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

    // Deterministic "Generated at" timestamp (markdown format only) —
    // TEST_CASES.md ROAD-09 requires byte-identical content across two
    // calls with no DB changes in between, which a live `new Date()`
    // can't satisfy (it differs on literally every call). Seeded from the
    // project's own `updated_at` and raised to the latest `updated_at`
    // seen across whatever tracks/items actually end up in the rendered
    // content below — so it stays stable when nothing changed, and moves
    // forward exactly when the rendered data itself changed (satisfying
    // ROAD-08's "differs exactly where the DB differs and nowhere else"
    // at the same time).
    let latestUpdatedAt = project.updated_at;

    let allTracks: Awaited<ReturnType<typeof getTrackSummariesForProject>>;
    let trackEdges: Awaited<ReturnType<typeof getTrackDependencyEdges>>;
    let timedOutBeforeListing = false;
    try {
      // Sequential on this shared PoolClient — see get-project-status.ts's
      // comment on why these aren't run as a Promise.all.
      await setRemainingStatementTimeout(client, startedAt, timeBudgetMs);
      allTracks = await getTrackSummariesForProject(client, input.project_id);
      await setRemainingStatementTimeout(client, startedAt, timeBudgetMs);
      trackEdges = await getTrackDependencyEdges(client, input.project_id);
    } catch (error) {
      if (!isQueryCanceled(error)) throw error;
      // The budget was blown before we could even list the project's
      // tracks — degrade to an empty roadmap rather than a 500 (§6.3's
      // "never turn a large project into a hard failure", taken to its
      // logical extreme: even listing the tracks can be too slow).
      allTracks = [];
      trackEdges = [];
      timedOutBeforeListing = true;
    }

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
      if (track.updated_at > latestUpdatedAt) latestUpdatedAt = track.updated_at;
      // Checked before every per-track fetch (including the first) —
      // see this file's top-of-file comment for why this, not a
      // Promise.race, is the only place a time budget can mostly bite;
      // `setRemainingStatementTimeout` below is what bounds an
      // individual slow query rather than just the gaps between them.
      if (Date.now() - startedAt > timeBudgetMs) {
        break;
      }
      let rows: Awaited<ReturnType<typeof listItemsByTrackCapped>>;
      try {
        await setRemainingStatementTimeout(client, startedAt, timeBudgetMs);
        rows = await listItemsByTrackCapped(client, track.id, config.roadmapItemPerTrackCap + 1);
      } catch (error) {
        if (!isQueryCanceled(error)) throw error;
        break;
      }
      if (rows.length > config.roadmapItemPerTrackCap) {
        itemCapHit = true;
      }
      itemsByTrackId.set(
        track.id,
        rows.slice(0, config.roadmapItemPerTrackCap).map((row) => {
          if (row.updated_at > latestUpdatedAt) latestUpdatedAt = row.updated_at;
          return { title: row.title, status: row.status };
        }),
      );
      includedTracks.push(track);
    }

    // Covers every truncation cause uniformly: the track cap, the
    // between-query time check, and a mid-query statement_timeout
    // cancellation all show up here as "fewer included tracks than the
    // project has" (or, in the timedOutBeforeListing case, than it might
    // have — we never found out).
    const trackTruncated = includedTracks.length < allTracks.length;

    let content: string;
    if (input.format === 'mermaid') {
      const includedIds = new Set(includedTracks.map((t) => t.id));
      const edges = trackEdges.filter(
        (edge) => includedIds.has(edge.from) && includedIds.has(edge.to),
      );
      content = renderMermaidRoadmap(includedTracks, edges);
    } else {
      content = renderMarkdownRoadmap(
        project.name,
        latestUpdatedAt,
        includedTracks,
        itemsByTrackId,
      );
    }

    if (timedOutBeforeListing || trackTruncated || itemCapHit) {
      const clauses: string[] = [];
      if (timedOutBeforeListing) {
        clauses.push('time budget exceeded before any tracks could be scanned');
      } else if (trackTruncated) {
        // Exact wording per TRD §6.3's example — deliberately not
        // distinguishing "hit the track cap" from "hit the time budget"
        // here, since both mean the same thing to the caller (fewer
        // tracks than the project actually has) and TRD specifies one
        // wording, not two.
        clauses.push(`showing ${includedTracks.length} of ${allTracks.length} tracks`);
      }
      if (itemCapHit) {
        clauses.push(`some tracks omit items beyond the first ${config.roadmapItemPerTrackCap}`);
      }
      content = appendTruncationNotice(content, buildTruncationNotice(clauses), input.format);
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
