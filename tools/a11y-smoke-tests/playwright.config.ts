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

const webServerCommand = [
  'pnpm --filter @idle-engine/core run build',
  'pnpm --filter @idle-engine/shell-web run build',
  `pnpm --filter @idle-engine/shell-web run preview -- --host ${HOST} --port ${PORT} --strictPort`
].join(' && ');

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
    cwd: MONOREPO_ROOT
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
