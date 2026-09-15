import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Vendored from Jasper and kept byte-for-byte so upstream fixes can be
    // pulled in with a plain copy. Linting it would mean editing it.
    ignores: ['out/**', 'grail/**', 'src/gci/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.eslint.json' },
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
);
