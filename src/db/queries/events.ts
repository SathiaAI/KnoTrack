import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export interface EventRow {
  id: string;
  project_id: string;
  track_id: string | null;
  summary_text: string;
  files_touched: string[];
  items_touched: string[];
  created_at: Date;
}

export async function insertEvent(
  db: Queryable,
  input: {
    projectId: string;
    trackId: string;
    summaryText: string;
    filesTouched: string[];
    itemsTouched: string[];
  },
): Promise<EventRow> {
  const result = await db.query<EventRow>(
    `INSERT INTO events (project_id, track_id, summary_text, files_touched, items_touched)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING *`,
    [
      input.projectId,
      input.trackId,
      input.summaryText,
      JSON.stringify(input.filesTouched),
      JSON.stringify(input.itemsTouched),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertEvent: INSERT ... RETURNING produced no row');
  return row;
}

/** Was a session_summary event recorded for this track within the last
 * N days? Used by the STALE_TRACK-equivalent check. Returns the most
 * recent event's created_at, or null if none exist at all. */
export async function getMostRecentEventForTrack(
  db: Queryable,
  trackId: string,
): Promise<Date | null> {
  const result = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM events WHERE track_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [trackId],
  );
  return result.rows[0]?.created_at ?? null;
}

export interface TimelineEntry {
  event_id: string;
  event_type: 'session_summary' | 'decision';
  track_id: string | null;
  summary_text: string;
  created_at: Date;
}

/**
 * TRD §3.3 asks kt_get_project_status's `recent_events` to union
 * session_summary events and decision events, newest first. The real
 * schema (migrations/001_init.sql) keeps those as two separate tables
 * (`events`, `decisions`) with no shared `event_type` discriminator
 * column and no single `summary_text` field on `decisions` — so this
 * query synthesizes both: a decision row's `title` stands in for
 * `summary_text` (decisions have no free-text field that plays the same
 * role events' summary_text does).
 */
export async function getRecentTimeline(
  db: Queryable,
  projectId: string,
  limit: number,
): Promise<TimelineEntry[]> {
  const result = await db.query<TimelineEntry>(
    `(
       SELECT id AS event_id, 'session_summary'::text AS event_type, track_id, summary_text, created_at
       FROM events
       WHERE project_id = $1
     )
     UNION ALL
     (
       SELECT id AS event_id, 'decision'::text AS event_type, track_id, title AS summary_text, created_at
       FROM decisions
       WHERE project_id = $1
     )
     ORDER BY created_at DESC
     LIMIT $2`,
    [projectId, limit],
  );
  return result.rows;
}
