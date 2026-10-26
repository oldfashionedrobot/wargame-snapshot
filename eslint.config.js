import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['**/dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      // Last: turns off rules that would fight Prettier. A guard rather than a
      // fix -- none of the configs above enable formatting rules today.
      prettier,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Invariant 2: the rulebook has no I/O, no RNG and no clock. The compiler
    // catches only some of it here -- the client's DOM lib and the server's bun
    // types admit the rest -- so lint holds the line. Tests and scripts are dev
    // tooling and may use them.
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        'Date',
        'console',
        'crypto',
        'fetch',
        'localStorage',
        'navigator',
        'performance',
        'process',
        'queueMicrotask',
        'sessionStorage',
        'setInterval',
        'setTimeout',
        'WebSocket',
        'Worker',
      ],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random' }],
      'no-restricted-imports': ['error', { paths: ['bun'], patterns: ['node:*'] }],
    },
  },
]);
