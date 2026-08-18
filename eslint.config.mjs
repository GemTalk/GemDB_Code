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
);
