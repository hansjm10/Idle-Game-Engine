import { defineConfig, mergeConfig } from 'vitest/config';

const BASE_CONFIG = defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true,
    watchExclude: ['**/dist/**', '**/node_modules/**'],
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/node_modules/**', '**/*.d.ts']
    }
  }
});

export function createVitestConfig(overrides = {}) {
  return mergeConfig(BASE_CONFIG, overrides);
}

export function createBrowserVitestConfig(overrides = {}) {
  return mergeConfig(
    BASE_CONFIG,
    defineConfig({
      test: {
        environment: 'jsdom'
      }
    }),
    overrides
  );
}
