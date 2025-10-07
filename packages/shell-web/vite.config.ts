import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Placeholder Vite config for the web presentation shell. The runtime will
// execute inside a Web Worker and communicate via postMessage once integrated.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  }
});
