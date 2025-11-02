import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { defineConfig } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PREVIEW_HOST = 'localhost';
// Ignore host values that bind to "all interfaces" because browsers cannot connect to them directly.
const configuredHost = process.env.PLAYWRIGHT_PREVIEW_HOST ?? process.env.HOST;
const HOST =
  configuredHost &&
  configuredHost !== '0.0.0.0' &&
  configuredHost !== '::' &&
  configuredHost !== '[::]'
    ? configuredHost
    : DEFAULT_PREVIEW_HOST;
const PORT = Number.parseInt(process.env.PLAYWRIGHT_PREVIEW_PORT ?? '4173', 10);
const BASE_URL = `http://${HOST}:${PORT}`;

const MONOREPO_ROOT = resolve(__dirname, '../..');

// In CI, packages are already built by the 'Build' step, so we only need to run the preview server
// Bind to 127.0.0.1 for consistent localhost access across environments
const webServerCommand = `pnpm --filter @idle-engine/shell-web run preview -- --host ${HOST} --port ${PORT} --strictPort`;

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: {
    timeout: 10_000
  },
  reporter: process.env.CI ? 'line' : [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: webServerCommand,
    url: BASE_URL,
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
