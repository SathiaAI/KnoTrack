import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { registerProjectService } from '../../src/mcp/tools/register-project.js';
import { decryptCredential } from '../../src/crypto/credential-cipher.js';
import { closeTestPool, getTestConfig, getTestPool, truncateAll } from './helpers.js';

const pool = getTestPool();
const config = getTestConfig();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('kt_register_project', () => {
  it('positive: registers a new project and returns a project_id', async () => {
    const result = await registerProjectService(pool, config, {
      name: 'KnoTrack',
      source_type: 'github',
      source_ref: 'pjpoulose/knotrack',
      adapters: undefined,
    });
    expect(result.project_id).toMatch(/^[0-9a-f-]{36}$/i);

    const row = await pool.query('SELECT * FROM projects WHERE id = $1', [result.project_id]);
    expect(row.rows[0]).toMatchObject({
      name: 'KnoTrack',
      source_type: 'github',
      source_ref: 'pjpoulose/knotrack',
    });
  });

  it('positive: upserts on (source_type, source_ref) — same id, updated name, no duplicate row', async () => {
    const first = await registerProjectService(pool, config, {
      name: 'Old Name',
      source_type: 'local',
      source_ref: '/tmp/some/repo',
      adapters: undefined,
    });

    const second = await registerProjectService(pool, config, {
      name: 'New Name',
      source_type: 'local',
      source_ref: '/tmp/some/repo',
      adapters: undefined,
    });

    expect(second.project_id).toBe(first.project_id);

    const rows = await pool.query(
      'SELECT * FROM projects WHERE source_type = $1 AND source_ref = $2',
      ['local', '/tmp/some/repo'],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].name).toBe('New Name');
  });

  it('negative: adapter credentials are encrypted at rest, never stored as plaintext', async () => {
    const result = await registerProjectService(pool, config, {
      name: 'Has Secrets',
      source_type: 'github',
      source_ref: 'acme/widgets',
      adapters: {
        github: { personal_access_token: 'ghp_super_secret_value', repo: undefined },
      },
    });

    const adapterRow = await pool.query(
      'SELECT encrypted_credential, config FROM adapters WHERE project_id = $1 AND type = $2',
      [result.project_id, 'github'],
    );
    expect(adapterRow.rowCount).toBe(1);
    const encrypted: Buffer = adapterRow.rows[0].encrypted_credential;
    // The raw secret must never appear in the stored bytes.
    expect(encrypted.toString('utf8')).not.toContain('ghp_super_secret_value');
    expect(encrypted.toString('base64')).not.toContain(
      Buffer.from('ghp_super_secret_value').toString('base64'),
    );
    // But it must decrypt back to the original value with the right key.
    expect(decryptCredential(encrypted, config.encryptionKey)).toBe('ghp_super_secret_value');
    // Non-secret metadata defaults repo to source_ref for a github project.
    expect(adapterRow.rows[0].config).toMatchObject({ repo: 'acme/widgets', connected: true });
  });

  // adversarial-review P2: an adapter-storage failure used to attach the
  // raw driver/cipher error message to `details.cause`, which runTool
  // serializes verbatim into the client-facing envelope — leaking internals
  // through what TRD §3.1 documents as a generic 500. A too-short
  // encryption key makes `encryptCredential` throw a real Node crypto error
  // ("Invalid key length") without needing to fake a DB failure, exercising
  // the same catch block.
  it('negative: an adapter-storage failure logs the cause server-side but never returns it to the client', async () => {
    const loggedErrors: unknown[] = [];
    const spyLogger = { error: (obj: unknown) => loggedErrors.push(obj) };
    const badConfig = { ...config, encryptionKey: Buffer.alloc(10) };

    let thrown: unknown;
    try {
      await registerProjectService(
        pool,
        badConfig,
        {
          name: 'Bad key',
          source_type: 'github',
          source_ref: 'acme/broken-key',
          adapters: {
            github: { personal_access_token: 'ghp_whatever', repo: undefined },
          },
        },
        spyLogger,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'INTERNAL_ERROR' });
    const envelope = (
      thrown as { toEnvelope: () => { error: Record<string, unknown> } }
    ).toEnvelope().error;
    // No `details` at all — in particular, no leaked `details.cause`
    // carrying the raw "Invalid key length" crypto error text.
    expect(envelope.details).toBeUndefined();
    expect(JSON.stringify(envelope)).not.toMatch(/invalid key length/i);

    // But the cause was not silently swallowed — it went to the server log.
    expect(loggedErrors).toHaveLength(1);
    const loggedError = (loggedErrors[0] as { err: Error }).err;
    expect(loggedError.message).toMatch(/invalid key length/i);
  });
});
