import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';

export default tseslint.config(
  {
    // src/gci/** is vendored from Jasper and kept byte-for-byte so upstream
    // fixes can be pulled in with a plain copy; linting it would mean editing
    // it. The rest are build artifacts that ESLint would otherwise walk on
    // its own, since (unlike Prettier 3) it does not read .gitignore: out/**
    // is this project's own bundle, grail/** and mcp/** are third-party
    // payloads staged by bundle-grail.sh and bundle-mcp.sh, dist/** is
    // packages fetched from CI by fetch-vsix.sh, and .test-extent/** is the
    // database extent build-test-extent.sh builds for the integration suite.
    ignores: ['out/**', 'grail/**', 'mcp/**', 'dist/**', '.test-extent/**', 'src/gci/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Catches stale `eslint-disable` comments that no longer suppress anything.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    plugins: { 'eslint-comments': eslintComments },
    rules: {
      // Require a `-- reason` on every eslint-disable comment, so suppressions
      // must be justified inline instead of silently added.
      'eslint-comments/require-description': 'error',
    },
  },
  {
    files: ['src/**/*.ts', '__mocks__/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // `out/gemdb-shell.js` is bundled from this same `src/`, with `vscode`
    // aliased to cliVscode.ts — there is no extension host there, so nothing
    // would enforce the user's telemetry setting if telemetry.ts entered that
    // graph. This denylist names every file that reaches that bundle — the 4
    // shell-only files plus the 11 shared with the extension host (per
    // `esbuild --analyze`) — so instrumenting an extension-host-only file
    // (lifecycle.ts, notebook.ts, mcp.ts, ...) needs no lint edit, while the
    // case that actually matters still fails at save time. `session.ts` and
    // `pythonQueries.ts` are in this list on purpose: they are where phase 3's
    // events (sessionLimitReached, pythonError) would naturally go, and they
    // stay off-limits to a direct import forever — reachable only through an
    // injected sink, the move `pyRepl.ts` already makes with its `ReplWorld`
    // argument. The metafile check in esbuild.mjs is the guard that actually
    // holds; this one only catches the honest mistake in the editor, so drift
    // between this list and the real graph is acceptable.
    files: [
      // Shell-only
      'src/cliMain.ts',
      'src/cliVscode.ts',
      'src/lineEditor.ts',
      'src/pyRepl.ts',
      // Shared between the shell and the extension host
      'src/config.ts',
      'src/gci/**/*.ts',
      'src/gslist.ts',
      'src/log.ts',
      'src/paths.ts',
      'src/platform.ts',
      'src/processes.ts',
      'src/pythonQueries.ts',
      'src/session.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/telemetry'],
              message:
                'This file reaches out/gemdb-shell.js, where there is no extension ' +
                "host to enforce the user's telemetry setting. To add an event, add " +
                'a report* function in src/telemetry.ts and call it from a file ' +
                'outside the shell graph (extension.ts, lifecycle.ts, ...).',
            },
          ],
        },
      ],
    },
  },
  {
    // The build and tooling scripts, which are Node rather than TypeScript.
    // `js.configs.recommended` applies repo-wide and turns on `no-undef`, but
    // the only languageOptions above are scoped to `src/**/*.ts` — so without
    // this block ESLint reads these with ES builtins alone and calls every
    // `process` and `console` undefined. `.js` and `.cjs` need the same
    // globals for the same reason `.mjs` does.
    files: ['**/*.{mjs,cjs,js}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
