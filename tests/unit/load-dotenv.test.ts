import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnvIfPresent } from '../../src/config/load-dotenv.js';

// adversarial-review P1: the quick-start docs tell a local developer to
// `cp .env.example .env`, but nothing ever loaded it — tsx/npm don't do so
// implicitly. loadDotEnvIfPresent is what every entrypoint (src/index.ts,
// scripts/migrate.ts, scripts/seed-self.ts) now calls to fix that, and it
// has to behave correctly in both directions: load the file when a local
// developer has one, and stay a no-op in production, where none exists.
describe('loadDotEnvIfPresent', () => {
  const originalCwd = process.cwd();
  const VAR_NAME = 'KNOTRACK_LOAD_DOTENV_TEST_VAR';

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env[VAR_NAME];
  });

  it('positive: loads variables from a .env file in the current working directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'knotrack-dotenv-test-'));
    try {
      writeFileSync(path.join(dir, '.env'), `${VAR_NAME}=from-dotenv-file\n`, 'utf8');
      process.chdir(dir);

      expect(process.env[VAR_NAME]).toBeUndefined();
      loadDotEnvIfPresent();
      expect(process.env[VAR_NAME]).toBe('from-dotenv-file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('negative: does not throw and leaves process.env untouched when no .env file exists (the production case)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'knotrack-dotenv-test-empty-'));
    try {
      process.chdir(dir);
      expect(() => loadDotEnvIfPresent()).not.toThrow();
      expect(process.env[VAR_NAME]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
