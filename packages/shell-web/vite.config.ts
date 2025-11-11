import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Placeholder Vite config for the web presentation shell. The runtime will
// execute inside a Web Worker and communicate via postMessage once integrated.
const sharedHost = process.env.SHELL_WEB_HOST ?? '127.0.0.1';
const strictPort = process.env.SHELL_WEB_STRICT_PORT === 'true';
const devHost = process.env.SHELL_WEB_DEV_HOST ?? sharedHost;
const devPort = Number.parseInt(process.env.SHELL_WEB_DEV_PORT ?? process.env.SHELL_WEB_PORT ?? '5173', 10);
const previewHost = process.env.SHELL_WEB_PREVIEW_HOST ?? sharedHost;
const previewPort = Number.parseInt(process.env.SHELL_WEB_PREVIEW_PORT ?? '4173', 10);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@idle-engine/core': path.resolve(
        projectRoot,
        '../core/src/index.ts',
      ),
      '@idle-engine/runtime-bridge-contracts': path.resolve(
        projectRoot,
        '../runtime-bridge-contracts/src',
      ),
      '@idle-engine/content-schema/runtime-helpers': path.resolve(
        projectRoot,
        '../content-schema/src/runtime-helpers.ts',
      ),
      '@idle-engine/content-schema': path.resolve(
        projectRoot,
        '../content-schema/src',
      ),
      '@idle-engine/content-sample': path.resolve(
        projectRoot,
        '../content-sample/src',
      ),
    },
  },
  server: {
    host: devHost,
    port: devPort,
    strictPort,
  },
  preview: {
    host: previewHost,
    port: previewPort,
    strictPort,
  },
});
