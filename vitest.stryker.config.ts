import { defineConfig } from 'vitest/config';

// Used only by Stryker mutation testing (stryker.conf.json). Scoped to
// tests/unit — the mutated files (dependency-graph, drift-detector,
// credential-cipher, auth) are all pure/deterministic and covered there.
// Excludes tests/integration: those hit a real local Postgres and would
// make thousands of mutant runs slow and DB-contention-prone for no
// coverage benefit on these four files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 20000,
  },
});
