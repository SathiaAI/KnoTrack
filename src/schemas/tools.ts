// One zod schema per tool — single source of truth (TRD §3.0). Each is a
// `.strict()` ZodObject so the MCP SDK's tools/list JSON Schema output
// carries "additionalProperties": false, and so runtime parsing rejects
// any field not listed, per TRD §3.0's closed-schema rule.
import { z } from 'zod';

const uuid = () => z.string().uuid();

// adversarial-review security-3 (final rerun, docs/ROADMAP.md T9.x): these
// credential/config strings had no upper bound, so an authenticated caller
// could submit an arbitrarily large payload — a storage/memory DoS vector,
// not just a correctness gap. Bounds are generous relative to real token
// shapes (GitHub PATs top out well under 256 chars; Linear API keys and
// team ids are short identifiers) while still being a real ceiling.
const githubAdapterInput = z
  .object({
    personal_access_token: z.string().min(1).max(512),
    repo: z.string().min(1).max(200).optional(),
  })
  .strict();

const linearAdapterInput = z
  .object({
    api_key: z.string().min(1).max(512),
    team_id: z.string().min(1).max(200),
  })
  .strict();

export const registerProjectInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    source_type: z.enum(['github', 'linear', 'local']),
    source_ref: z.string().min(1).max(500),
    adapters: z
      .object({
        github: githubAdapterInput.optional(),
        linear: linearAdapterInput.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const getProjectStatusInputSchema = z
  .object({
    project_id: uuid(),
  })
  .strict();

export const listTracksInputSchema = z
  .object({
    project_id: uuid(),
    status: z.enum(['on_track', 'pivot_pending', 'blocked', 'done']).optional(),
  })
  .strict();

export const getTrackInputSchema = z
  .object({
    project_id: uuid(),
    track_id: uuid(),
  })
  .strict();

export const getNextStepsInputSchema = z
  .object({
    project_id: uuid(),
  })
  .strict();

export const createTrackInputSchema = z
  .object({
    project_id: uuid(),
    title: z.string().min(1).max(300),
    depends_on: z.array(uuid()).max(50).default([]),
    source_doc_ref: z.string().max(500).optional(),
  })
  .strict();

export const createItemInputSchema = z
  .object({
    project_id: uuid(),
    track_id: uuid(),
    title: z.string().min(1).max(300),
    sequence_position: z.number().int().min(0).optional(),
    depends_on: z.array(uuid()).max(100).default([]),
  })
  .strict();

export const recordSessionSummaryInputSchema = z
  .object({
    project_id: uuid(),
    track_id: uuid(),
    summary_text: z.string().min(1).max(10000),
    // adversarial-review security-3 (final rerun, docs/ROADMAP.md T9.x): the
    // per-string .max(1000) bounded each file path's length, but the array
    // itself had no .max() — an authenticated caller could still submit an
    // unbounded number of entries. 500 comfortably covers a real session's
    // touched-file count while capping worst-case payload size.
    files_touched: z.array(z.string().min(1).max(1000)).max(500).default([]),
    items_touched: z.array(uuid()).default([]),
  })
  .strict();

export const recordDecisionInputSchema = z
  .object({
    project_id: uuid(),
    track_id: uuid(),
    title: z.string().min(1).max(300),
    rationale: z.string().min(1).max(5000),
    what_changed: z.string().min(1).max(5000),
  })
  .strict();

export const updateItemStatusInputSchema = z
  .object({
    project_id: uuid(),
    item_id: uuid(),
    status: z.enum(['pending', 'in_progress', 'done', 'blocked']),
  })
  .strict();

export const checkDriftInputSchema = z
  .object({
    project_id: uuid(),
  })
  .strict();

export const renderRoadmapInputSchema = z
  .object({
    project_id: uuid(),
    format: z.enum(['markdown', 'mermaid']).default('markdown'),
  })
  .strict();

export const syncToGithubInputSchema = z
  .object({
    project_id: uuid(),
    track_id: uuid(),
  })
  .strict();

export const syncToLinearInputSchema = z
  .object({
    project_id: uuid(),
    track_id: uuid(),
  })
  .strict();

export type RegisterProjectInput = z.infer<typeof registerProjectInputSchema>;
export type GetProjectStatusInput = z.infer<typeof getProjectStatusInputSchema>;
export type ListTracksInput = z.infer<typeof listTracksInputSchema>;
export type GetTrackInput = z.infer<typeof getTrackInputSchema>;
export type GetNextStepsInput = z.infer<typeof getNextStepsInputSchema>;
export type CreateTrackInput = z.infer<typeof createTrackInputSchema>;
export type CreateItemInput = z.infer<typeof createItemInputSchema>;
export type RecordSessionSummaryInput = z.infer<typeof recordSessionSummaryInputSchema>;
export type RecordDecisionInput = z.infer<typeof recordDecisionInputSchema>;
export type UpdateItemStatusInput = z.infer<typeof updateItemStatusInputSchema>;
export type CheckDriftInput = z.infer<typeof checkDriftInputSchema>;
export type RenderRoadmapInput = z.infer<typeof renderRoadmapInputSchema>;
export type SyncToGithubInput = z.infer<typeof syncToGithubInputSchema>;
export type SyncToLinearInput = z.infer<typeof syncToLinearInputSchema>;
