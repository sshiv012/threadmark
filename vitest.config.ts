import { defineConfig } from 'vitest/config';

// Root Vitest config. Each package also runs `vitest run` via its own `test`
// script (fanned out by Turbo); Vitest picks up *.test.ts files by default.
export default defineConfig({
  test: {
    globals: false,
    include: ['**/src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
