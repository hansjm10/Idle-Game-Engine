import * as mdx from 'eslint-plugin-mdx';

const remarkConfigPath = new URL('./.remarkrc.mjs', import.meta.url).pathname;

export default [
  {
    ignores: ['**/node_modules/**', '**/build/**'],
  },
  {
    ...mdx.flat,
    settings: {
      ...(mdx.flat.settings ?? {}),
      'mdx/remark-config-path': remarkConfigPath,
      'mdx/ignore-remark-config': false,
    },
    rules: {
      ...mdx.flat.rules,
      'mdx/remark': 'error',
    },
  },
];
