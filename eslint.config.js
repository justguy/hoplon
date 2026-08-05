// eslint.config.js — flat config (ESLint 9+)
// A1: TypeScript baseline rules.
// A2: Import-boundary rule added below the A2 marker.

import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // Global ignores
  {
    ignores: ['dist/**', '**/dist/**', 'node_modules/**', 'vendor/**', '**/*.ts.txt'],
  },

  // TypeScript source files
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.test.json',
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // TypeScript strict baseline
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],

      // A2: Import boundary rules (defensive — listed paths don't exist in this repo
      // yet, but the rule fires when this repo is moved into a Phalanx workspace)
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/pipeline/**'],
              message: 'Hoplon must not import from pipeline layers.',
            },
            {
              group: ['**/agents/**'],
              message: 'Hoplon must not import from agent layers.',
            },
            {
              group: ['**/process-ledger/**'],
              message: 'Hoplon must not import from process-ledger.',
            },
            {
              group: ['**/adr-graph/**'],
              message: 'Hoplon must not import from adr-graph.',
            },
          ],
        },
      ],
    },
  },
];

export default config;
