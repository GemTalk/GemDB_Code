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
    // graph. This is an allowlist of one; a module outside the shell graph
    // that later wants an event gets added deliberately.
    files: ['src/**/*.ts'],
    ignores: ['src/extension.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/telemetry'],
              message:
                'Only src/extension.ts may import telemetry: it must not reach the ' +
                'out/gemdb-shell.js bundle, where there is no extension host to ' +
                "enforce the user's telemetry setting. To add an event, add a " +
                'report* function in src/telemetry.ts and call it from extension.ts.',
            },
          ],
        },
      ],
    },
  },
);
