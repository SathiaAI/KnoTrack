import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 20000,
    // Integration tests hit a real local Postgres and share pooled
    // connections/rows via project-scoped fixtures; run files serially to
    // avoid cross-test interference on the same scratch database.
    fileParallelism: false,
  },
});
