import { mergeConfig, defineConfig } from 'vite';
import { createBrowserVitestConfig } from '@idle-engine/config-vitest';
import viteConfig from './vite.config.js';

const vitestConfig = createBrowserVitestConfig();

export default mergeConfig(
  viteConfig,
  defineConfig({
    ...vitestConfig,
    test: {
      ...vitestConfig.test,
      setupFiles: ['./vitest.setup.ts'],
    },
  })
);
