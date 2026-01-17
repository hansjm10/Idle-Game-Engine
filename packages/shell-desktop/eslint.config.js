import { createConfig } from '@idle-engine/config-eslint';

export default [
  ...createConfig({
    restrictCoreInternals: 'error',
  }),
  {
    files: ['src/preload.cts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
