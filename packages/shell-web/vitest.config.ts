import { mergeConfig } from 'vite';
import { createBrowserVitestConfig } from '@idle-engine/config-vitest';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  createBrowserVitestConfig()
);
