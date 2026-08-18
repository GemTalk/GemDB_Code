import { defineConfig } from 'vitest/config';

/**
 * The suite that needs a real database.
 *
 * Kept apart from `npm test` on purpose. These tests take seconds each, start
 * processes that outlive the runner, and cannot run in parallel with each other
 * — there is one database, and its state is the thing under test.
 */
export default defineConfig({
  test: {
    include: ['src/__integration__/**/*.test.ts'],
    // Starting a stone, filing anything in, and stopping it again are all
    // well past vitest's 5-second default.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    alias: {
      vscode: new URL('src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
