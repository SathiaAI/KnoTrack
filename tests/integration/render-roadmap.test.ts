import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { renderRoadmapService } from '../../src/mcp/tools/render-roadmap.js';
import { createItemService } from '../../src/mcp/tools/create-item.js';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll, UNKNOWN_UUID } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeProject(name = 'KnoTrack Demo'): Promise<string> {
  const { project_id } = await registerProjectService(pool, config, {
    name,
    source_type: 'local',
    source_ref: `/tmp/${crypto.randomUUID()}`,
    adapters: undefined,
  });
  return project_id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_render_roadmap', () => {
  it('positive: markdown format matches TRD §3.13 exactly, including all four checkbox variants', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Auth overhaul',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const done = await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Add refresh endpoint',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'done' WHERE id = $1`, [done.item_id]);
    await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Add rotation tests',
      sequence_position: undefined,
      depends_on: [],
    });

    const result = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(result.content).toMatch(/^# Roadmap: KnoTrack Demo\n_Generated \d{4}-\d{2}-\d{2}T/);
    expect(result.content).toContain('## Auth overhaul — on_track\n');
    expect(result.content).toContain('- [x] Add refresh endpoint');
    expect(result.content).toContain('- [ ] Add rotation tests');
  });

  it('positive: renders in_progress and blocked checkboxes correctly', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const inProgress = await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'In progress item',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'in_progress' WHERE id = $1`, [inProgress.item_id]);
    const blocked = await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Blocked item',
      sequence_position: undefined,
      depends_on: [],
    });
    await pool.query(`UPDATE items SET status = 'blocked' WHERE id = $1`, [blocked.item_id]);

    const result = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(result.content).toContain('- [~] In progress item');
    expect(result.content).toContain('- [!] Blocked item');
  });

  it('positive: topological ordering across a real dependency chain (C depends on B depends on A)', async () => {
    const projectId = await makeProject();
    const trackA = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const trackB = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [trackA.track_id],
      source_doc_ref: undefined,
    });
    await createTrackService(pool, config, {
      project_id: projectId,
      title: 'C',
      depends_on: [trackB.track_id],
      source_doc_ref: undefined,
    });

    const result = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    const indexA = result.content.indexOf('## A —');
    const indexB = result.content.indexOf('## B —');
    const indexC = result.content.indexOf('## C —');
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(indexB);
    expect(indexB).toBeLessThan(indexC);
    // Sanity: B and C are blocked (their prerequisite isn't done).
    expect(result.content).toContain('## B — blocked');
    expect(result.content).toContain('## C — blocked');
  });

  it('positive: mermaid format uses correct node ids, sanitizes quotes/newlines, and preserves edge direction', async () => {
    const projectId = await makeProject();
    const trackA = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Say "hi"\nfolks',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const trackB = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'Billing sync',
      depends_on: [trackA.track_id],
      source_doc_ref: undefined,
    });

    const result = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'mermaid',
    });

    const nodeIdA = `t_${trackA.track_id.split('-')[0]}`;
    const nodeIdB = `t_${trackB.track_id.split('-')[0]}`;

    expect(result.content.startsWith('graph TD\n')).toBe(true);
    expect(result.content).toContain(`${nodeIdA}["Say 'hi'folks (on_track)"]`);
    expect(result.content).not.toContain('"hi"');
    expect(result.content).toContain(`${nodeIdB}["Billing sync (blocked)"]`);
    // B depends on A, per TRD §3.13's "A --> B means A depends on B" —
    // here that's B --> A.
    expect(result.content).toContain(`${nodeIdB} --> ${nodeIdA}`);
    // Nodes declared before edges.
    expect(result.content.indexOf(`${nodeIdA}[`)).toBeLessThan(result.content.indexOf('-->'));
  });

  it('positive: cap-based truncation on both tracks and items reports the exact §6.3 notice format', async () => {
    const projectId = await makeProject();
    const trackIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO tracks (project_id, title, status) VALUES ($1, $2, 'on_track') RETURNING id`,
        [projectId, `Track ${i}`],
      );
      trackIds.push(inserted.rows[0]!.id);
    }
    // The first (oldest, so topologically earliest with no edges at all)
    // track gets more items than the per-track cap will allow.
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO items (track_id, title, sequence_position, status) VALUES ($1, $2, $3, 'pending')`,
        [trackIds[0], `Item ${i}`, i],
      );
    }

    const smallCapConfig = { ...config, roadmapTrackCap: 3, roadmapItemPerTrackCap: 2 };
    const result = await renderRoadmapService(pool, smallCapConfig, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(result.content).toContain(
      '> Roadmap truncated: showing 3 of 5 tracks. Some tracks omit items beyond the first 2.',
    );
  });

  it('positive: item-only cap truncation (no track truncation) omits the track-count clause', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });
    for (let i = 0; i < 4; i++) {
      await pool.query(
        `INSERT INTO items (track_id, title, sequence_position, status) VALUES ($1, $2, $3, 'pending')`,
        [track.track_id, `Item ${i}`, i],
      );
    }

    const smallItemCapConfig = { ...config, roadmapItemPerTrackCap: 2 };
    const result = await renderRoadmapService(pool, smallItemCapConfig, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(result.content).toContain(
      '> Roadmap truncated: some tracks omit items beyond the first 2.',
    );
    expect(result.content).not.toContain('of 1 tracks');
  });

  it('positive: mermaid truncation notice is a %% comment, not a markdown blockquote (valid Mermaid syntax)', async () => {
    const projectId = await makeProject();
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO tracks (project_id, title, status) VALUES ($1, $2, 'on_track')`,
        [projectId, `Track ${i}`],
      );
    }

    const smallCapConfig = { ...config, roadmapTrackCap: 2 };
    const result = await renderRoadmapService(pool, smallCapConfig, {
      project_id: projectId,
      format: 'mermaid',
    });

    expect(result.content).toContain('%% Roadmap truncated: showing 2 of 3 tracks.');
    expect(result.content).not.toContain('> Roadmap truncated');
  });

  it('positive: two consecutive calls with no DB changes return byte-identical content (ROAD-09)', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });
    await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'Item',
      sequence_position: undefined,
      depends_on: [],
    });

    const first = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });
    const second = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(second.content).toBe(first.content);
  });

  it('positive: re-rendering after a new item is created changes content only where the DB changed (ROAD-08)', async () => {
    const projectId = await makeProject();
    const track = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });

    const baseline = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    await createItemService(pool, config, {
      project_id: projectId,
      track_id: track.track_id,
      title: 'New item',
      sequence_position: undefined,
      depends_on: [],
    });

    const after = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(after.content).not.toBe(baseline.content);
    expect(after.content).toContain('- [ ] New item');
    expect(after.content).toContain('## T — on_track');
  });

  it('positive: no truncation notice appended when the project is within every cap', async () => {
    const projectId = await makeProject();
    await createTrackService(pool, config, {
      project_id: projectId,
      title: 'T',
      depends_on: [],
      source_doc_ref: undefined,
    });

    const result = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(result.content).not.toContain('Roadmap truncated');
  });

  it('positive: a project with zero tracks renders a header-only roadmap using the project row for the timestamp fallback', async () => {
    const projectId = await makeProject();

    const result = await renderRoadmapService(pool, config, {
      project_id: projectId,
      format: 'markdown',
    });

    expect(result.content).toMatch(/^# Roadmap: KnoTrack Demo\n_Generated \d{4}-\d{2}-\d{2}T/);
    expect(result.content).not.toContain('##');
  });

  it('negative: 404 when project does not exist', async () => {
    await expect(
      renderRoadmapService(pool, config, { project_id: UNKNOWN_UUID, format: 'markdown' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
