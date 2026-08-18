import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Named explicitly so that src/__integration__ — which needs a real
    // database and its own config — is never swept up by `npm test`.
    include: ['src/__tests__/**/*.test.ts'],
    // `vscode` is supplied by the editor at run time and has no npm package, so
    // anything importing it is unloadable in a test process. The stub in
    // src/__mocks__ stands in for it — see that file for what it deliberately
    // does not cover.
    alias: {
      vscode: new URL('src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
