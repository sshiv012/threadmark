import { defineConfig } from 'vitest/config';

// Root Vitest config. Each package also runs `vitest run` via its own `test`
// script (fanned out by Turbo); Vitest picks up *.test.ts files by default.
export default defineConfig({
  test: {
    globals: false,
    include: ['**/src/**/*.test.ts'],
    passWithNoTests: true,
    // Many test files spin up a fresh in-process Postgres (PGlite) + run the
    // real migration in beforeEach — normally well under a second, but under
    // CI's shared/throttled CPU this occasionally exceeded Vitest's default
    // 10s hookTimeout, aborting the hook mid-setup and leaving test-local
    // state (e.g. an OTel span exporter) unassigned for afterEach to use.
    hookTimeout: 30000,
  },
});
