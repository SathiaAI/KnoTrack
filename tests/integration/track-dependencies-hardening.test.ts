// Regression coverage for PR #16 escalated findings 3 and 4 (project doc
// "PR #16 escalated findings — frontier panel review", migration
// 008_pivot_and_dependency_hardening.sql):
//
//   Finding 3 — track_dependencies had no schema-level project scoping;
//     kt_create_track's application code was the only thing stopping a
//     cross-project edge.
//   Finding 4 — the cycle-prevention trigger had a snapshot-isolation
//     race (two concurrent inserts could jointly form a cycle) and a
//     false-positive bug on its own UPDATE path.
//
// Neither gap is reachable through the current MCP tool set (kt_create_track
// only ever links a brand-new track to already-existing ones in the same
// project, one INSERT at a time), so — like migration 007's tests — these
// go straight at the database with raw SQL/direct connections, the way a
// future writer, a migration, or a psql session could.
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTrackService } from '../../src/mcp/tools/create-track.js';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

async function makeProject(): Promise<string> {
  const { project_id } = await registerProjectService(pool, config, {
    name: 'P',
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

describe('migration 008 (PR #16 escalated finding 3): track_dependencies project scoping', () => {
  it('negative: a raw INSERT linking two tracks from different projects is rejected by the database', async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectA,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectB,
      title: 'B',
      depends_on: [],
      source_doc_ref: undefined,
    });

    // Tag the edge with A's project_id — depends_on_track_id (B) belongs
    // to a different project, so td_dep_same_project must reject it.
    await expect(
      pool.query(
        'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
        [a.track_id, b.track_id, projectA],
      ),
    ).rejects.toMatchObject({
      code: '23503', // foreign_key_violation
      constraint: 'td_dep_same_project',
    });
  });

  it('negative: a raw INSERT tagged with a project_id that matches neither track is rejected by the database', async () => {
    const projectA = await makeProject();
    const projectC = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectA,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectA,
      title: 'B',
      depends_on: [],
      source_doc_ref: undefined,
    });

    await expect(
      pool.query(
        'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
        [a.track_id, b.track_id, projectC],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'td_track_same_project',
    });
  });

  it("positive: a same-project edge, correctly tagged, is accepted (kt_create_track's own path)", async () => {
    const projectId = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [a.track_id],
      source_doc_ref: undefined,
    });

    const row = await pool.query(
      'SELECT project_id FROM track_dependencies WHERE track_id = $1 AND depends_on_track_id = $2',
      [b.track_id, a.track_id],
    );
    expect(row.rows).toMatchObject([{ project_id: projectId }]);
  });
});

describe('migration 008 (PR #16 escalated finding 4): cycle trigger — UPDATE false positive and concurrent-insert race', () => {
  it('positive: correcting an edge A->B to B->A via UPDATE succeeds (previously a false-positive "cycle")', async () => {
    const projectId = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [],
      source_doc_ref: undefined,
    });

    await pool.query(
      'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
      [a.track_id, b.track_id, projectId],
    );

    // Before migration 008's fix, this UPDATE was rejected as a false
    // "cycle" because the trigger's reachability check still saw the
    // pre-update A->B row while validating the new B->A row.
    await pool.query(
      'UPDATE track_dependencies SET track_id = $1, depends_on_track_id = $2 WHERE track_id = $3 AND depends_on_track_id = $4',
      [b.track_id, a.track_id, a.track_id, b.track_id],
    );

    const rows = await pool.query(
      'SELECT track_id, depends_on_track_id FROM track_dependencies WHERE project_id = $1',
      [projectId],
    );
    expect(rows.rows).toMatchObject([{ track_id: b.track_id, depends_on_track_id: a.track_id }]);
  });

  it('negative: a genuine cycle is still rejected via UPDATE (the false-positive fix does not also suppress real cycles)', async () => {
    const projectId = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const c = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'C',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const d = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'D',
      depends_on: [],
      source_doc_ref: undefined,
    });

    // Chain A -> B -> C (no cycle), plus an unrelated placeholder edge
    // C -> D we'll repoint via UPDATE.
    await pool.query(
      'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3), ($4, $5, $3), ($6, $7, $3)',
      [a.track_id, b.track_id, projectId, b.track_id, c.track_id, c.track_id, d.track_id],
    );

    // Repointing the unrelated C->D edge into C->A would close a real
    // cycle: A->B->C->A. The UPDATE-path fix excludes only the specific
    // (C, D) row being changed from the reachability walk — it must not
    // also blind the check to this genuinely-closed cycle.
    await expect(
      pool.query(
        'UPDATE track_dependencies SET depends_on_track_id = $1 WHERE track_id = $2 AND depends_on_track_id = $3',
        [a.track_id, c.track_id, d.track_id],
      ),
    ).rejects.toThrow(/dependency cycle/);
  });

  it('positive: two concurrent inserts that would jointly form a cycle are serialized by the advisory lock, and the second correctly rejects the now-visible cycle', async () => {
    const projectId = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [],
      source_doc_ref: undefined,
    });

    const client1 = new Client({ connectionString: config.databaseUrl });
    const client2 = new Client({ connectionString: config.databaseUrl });
    await client1.connect();
    await client2.connect();

    try {
      await client1.query('BEGIN');
      // Holds project `projectId`'s advisory lock for the rest of this
      // still-open transaction.
      await client1.query(
        'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
        [a.track_id, b.track_id, projectId],
      );

      let client2Settled = false;
      const client2Promise = (async () => {
        await client2.query('BEGIN');
        try {
          await client2.query(
            'INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES ($1, $2, $3)',
            [b.track_id, a.track_id, projectId],
          );
          await client2.query('COMMIT');
          return { ok: true as const };
        } catch (err) {
          await client2.query('ROLLBACK');
          return { ok: false as const, err };
        } finally {
          client2Settled = true;
        }
      })();

      // Without the advisory lock, both inserts would each pass their own
      // reachability check against the empty (pre-either-commit) table and
      // both succeed, silently creating a real 2-cycle. Give client2 a
      // moment: if the lock works, it must still be blocked here.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(client2Settled).toBe(false);

      await client1.query('COMMIT'); // releases the lock; A->B is now committed

      const client2Result = await client2Promise;
      expect(client2Result.ok).toBe(false);
      expect(String((client2Result as { err: unknown }).err)).toMatch(/dependency cycle/);

      const rows = await pool.query(
        'SELECT track_id, depends_on_track_id FROM track_dependencies WHERE project_id = $1',
        [projectId],
      );
      // Only A->B persisted; B->A was correctly rejected once serialized
      // behind A->B's commit — no cycle was ever stored.
      expect(rows.rows).toMatchObject([{ track_id: a.track_id, depends_on_track_id: b.track_id }]);
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  // Codex automated re-review of this PR: migration 008 also adds a
  // migration-time validation (run before any of its other changes) that
  // aborts if track_dependencies already contains a cycle — e.g. one that
  // slipped in through the very snapshot-isolation race this migration
  // closes, before it was closed. Exercising that requires a cycle to
  // exist in the table despite the trigger, which in a live, fully
  // migrated database (what `pool` here is) can only be fabricated by
  // disabling the trigger; running the actual migration file against a
  // pre-006 database is out of scope for this integration suite (see
  // tests/integration/migrate.test.ts for that kind of test), so this
  // exercises the validation's own reachability query directly — the same
  // one migrations/008_pivot_and_dependency_hardening.sql runs — against
  // fabricated pre-existing cycle data.
  it('negative (migration 008, Codex re-review): the pre-existing-cycle validation query detects a cycle already present in the data', async () => {
    const projectId = await makeProject();
    const a = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'A',
      depends_on: [],
      source_doc_ref: undefined,
    });
    const b = await createTrackService(pool, config, {
      project_id: projectId,
      title: 'B',
      depends_on: [],
      source_doc_ref: undefined,
    });

    await pool.query(
      'ALTER TABLE track_dependencies DISABLE TRIGGER trg_track_dependencies_no_cycle',
    );
    try {
      await pool.query(
        `INSERT INTO track_dependencies (track_id, depends_on_track_id, project_id) VALUES
           ($1, $2, $3), ($2, $1, $3)`,
        [a.track_id, b.track_id, projectId],
      );
    } finally {
      await pool.query(
        'ALTER TABLE track_dependencies ENABLE TRIGGER trg_track_dependencies_no_cycle',
      );
    }

    await expect(
      pool.query(`
        DO $$
        DECLARE
          cyclic_track_id uuid;
        BEGIN
          SELECT start_node INTO cyclic_track_id
          FROM (
            WITH RECURSIVE reach(start_node, node) AS (
              SELECT track_id, depends_on_track_id FROM track_dependencies
              UNION
              SELECT r.start_node, td.depends_on_track_id
              FROM track_dependencies td
              JOIN reach r ON td.track_id = r.node
            )
            SELECT start_node FROM reach WHERE node = start_node
          ) cycles
          LIMIT 1;

          IF cyclic_track_id IS NOT NULL THEN
            RAISE EXCEPTION 'track_dependencies: a pre-existing dependency cycle reaching back to track % was found', cyclic_track_id
              USING ERRCODE = '23514';
          END IF;
        END;
        $$;
      `),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('pre-existing dependency cycle'),
    });
  });
});
