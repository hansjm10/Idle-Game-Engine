import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.FlatConfig[]} */
const config = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Base TS rules (no type information required)
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports'
        }
      ],
      '@typescript-eslint/no-explicit-any': [
        'warn',
        {
          ignoreRestArgs: true
        }
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },
  // Typed TS rules (applied only to non-test files)
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.{test,spec}.ts', '**/*.{test,spec}.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': [
        'error',
        {
          fixMixedExportsWithInlineTypeSpecifier: true
        }
      ]
    }
  },
  {
    files: ['**/*.{test,spec}.ts', '**/*.{test,spec}.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
);

export default config;
