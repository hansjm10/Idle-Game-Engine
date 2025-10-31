import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Placeholder Vite config for the web presentation shell. The runtime will
// execute inside a Web Worker and communicate via postMessage once integrated.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
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
    port: 5173,
  },
});
