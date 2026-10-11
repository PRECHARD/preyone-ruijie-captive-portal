import { defineConfig } from 'vitest/config';

// Separate from the unit suite on purpose: this config includes ONLY the
// end-to-end specs, which talk to the real PostgreSQL instance (schema created
// by `npm run migrate`). `npm test` stays hermetic — every unit suite mocks the
// pool.
//
//   npx vitest run --config vitest.e2e.config.ts
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    // Each spec creates and drops its own company; running them serially keeps
    // the fixtures and the audit trail easy to read.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
