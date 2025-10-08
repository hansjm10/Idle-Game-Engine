import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { defineConfig } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOST = '127.0.0.1';
const PORT = 4173;
const BASE_URL = `http://${HOST}:${PORT}`;

const MONOREPO_ROOT = resolve(__dirname, '../..');

// In CI, packages are already built by the 'Build' step, so we only need to run the preview server
// Use 0.0.0.0 to bind to all interfaces, making it accessible from 127.0.0.1
const webServerCommand = `pnpm --filter @idle-engine/shell-web run preview -- --host 0.0.0.0 --port ${PORT} --strictPort`;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: {
    timeout: 5_000
  },
  reporter: process.env.CI ? 'line' : [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: webServerCommand,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: MONOREPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium'
      }
    }
  ]
});
