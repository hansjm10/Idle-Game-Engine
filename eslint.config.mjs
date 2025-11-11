import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    files: ['packages/shell-web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './modules/runtime-worker-protocol.js',
              message:
                'Use @idle-engine/runtime-bridge-contracts as the canonical schema package.',
            },
            {
              name: '../modules/runtime-worker-protocol.js',
              message:
                'Use @idle-engine/runtime-bridge-contracts as the canonical schema package.',
            },
          ],
          patterns: [
            {
              group: [
                '**/modules/runtime-worker-protocol',
                '**/modules/runtime-worker-protocol.js',
                '**/modules/runtime-worker-protocol.ts',
              ],
              message:
                'Use @idle-engine/runtime-bridge-contracts as the canonical schema package.',
            },
          ],
        },
      ],
    },
  },
);
