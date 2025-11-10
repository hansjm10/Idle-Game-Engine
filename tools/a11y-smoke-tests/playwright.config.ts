import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { defineConfig } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_HOST = '127.0.0.1';
// Ignore host values that bind to "all interfaces" because browsers cannot connect to them directly.
const configuredHost = process.env.PLAYWRIGHT_PREVIEW_HOST ?? process.env.HOST;
const HOST =
  configuredHost &&
  configuredHost !== '0.0.0.0' &&
  configuredHost !== '::' &&
  configuredHost !== '[::]'
    ? configuredHost
    : DEFAULT_HOST;

const PREVIEW_PORT = Number.parseInt(process.env.PLAYWRIGHT_PREVIEW_PORT ?? '4173', 10);
// PLAYWRIGHT_DEV_PORT lets contributors point the suite at an existing `pnpm dev` server when debugging locally.
const DEV_PORT = Number.parseInt(process.env.PLAYWRIGHT_DEV_PORT ?? '5173', 10);

const previewBaseUrl = `http://${HOST}:${PREVIEW_PORT}`;
const devBaseUrl = `http://${HOST}:${DEV_PORT}`;

const MONOREPO_ROOT = resolve(__dirname, '../..');

// In CI, packages are already built by the 'Build' step, so we only need to run the preview server
// Bind to 127.0.0.1 for consistent localhost access across environments
const previewServerCommand = `pnpm --filter @idle-engine/shell-web run preview -- --host ${HOST} --port ${PREVIEW_PORT} --strictPort`;
const devServerCommand = `pnpm --filter @idle-engine/shell-web run dev -- --host ${HOST} --port ${DEV_PORT} --strictPort`;
const reuseExistingServer = !process.env.CI;

const DEFAULT_TRACE_MODE = 'retain-on-failure' as const;

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: {
    timeout: 10_000
  },
  reporter: process.env.CI ? 'line' : [['html', { open: 'never' }], ['list']],
  projects: [
    {
      name: 'chromium-preview',
      use: {
        browserName: 'chromium',
        baseURL: previewBaseUrl,
        trace: DEFAULT_TRACE_MODE
      },
      webServer: {
        command: previewServerCommand,
        url: previewBaseUrl,
        reuseExistingServer,
        timeout: 120_000,
        cwd: MONOREPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe'

      },
      testIgnore: /shell-state-provider-restore\.spec\.ts/
    },
    {
      name: 'chromium-dev',
      use: {
        browserName: 'chromium',
        baseURL: devBaseUrl,
        trace: DEFAULT_TRACE_MODE
      },
      webServer: {
        command: devServerCommand,
        url: devBaseUrl,
        reuseExistingServer,
        timeout: 120_000,
        cwd: MONOREPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe'

      },
      testMatch: /shell-state-provider-restore\.spec\.ts/
    }
  ]
});
