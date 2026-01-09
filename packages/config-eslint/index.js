import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * @typedef {Readonly<{
 *   restrictCoreInternals?: false | 'warn' | 'error' | true;
 * }>} IdleEngineEslintOptions
 */

/**
 * @param {IdleEngineEslintOptions} [options]
 * @returns {import('eslint').Linter.FlatConfig[]}
 */
export function createConfig(options = {}) {
  const baseConfig = tseslint.config(
    {
      ignores: ['**/dist/**', '**/node_modules/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    // Base TS rules (no type information required)
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
      },
      rules: {
        'no-console': 'warn',
        'no-unused-vars': 'off',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          {
            fixStyle: 'inline-type-imports',
            prefer: 'type-imports',
          },
        ],
        '@typescript-eslint/no-explicit-any': [
          'warn',
          {
            ignoreRestArgs: true,
          },
        ],
        '@typescript-eslint/no-unused-vars': [
          'warn',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
          },
        ],
      },
    },
    // Typed TS rules (applied only to non-test files)
    {
      files: ['**/*.ts', '**/*.tsx'],
      ignores: ['**/*.{test,spec}.ts', '**/*.{test,spec}.tsx'],
      languageOptions: {
        parserOptions: {
          projectService: true,
        },
      },
      rules: {
        '@typescript-eslint/consistent-type-exports': [
          'error',
          {
            fixMixedExportsWithInlineTypeSpecifier: true,
          },
        ],
      },
    },
    {
      files: ['**/*.{test,spec}.ts', '**/*.{test,spec}.tsx'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  );

  const resolvedRestriction =
    options.restrictCoreInternals === true
      ? 'warn'
      : options.restrictCoreInternals;

  if (resolvedRestriction === false || resolvedRestriction === undefined) {
    return baseConfig;
  }

  return [
    ...baseConfig,
    {
      files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
      rules: {
        'no-restricted-imports': [
          resolvedRestriction,
          {
            paths: [
              {
                name: '@idle-engine/core/internals',
                message:
                  'Prefer @idle-engine/core (stable) for game code; @idle-engine/core/internals is experimental and may change without notice.',
              },
            ],
          },
        ],
      },
    },
  ];
}

export default createConfig();
