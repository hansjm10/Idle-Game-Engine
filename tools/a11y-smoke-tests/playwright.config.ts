import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

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

const DEFAULT_TRACE_MODE = 'retain-on-failure' as const;
const globalSetupPath = fileURLToPath(new URL('./playwright.global-setup.ts', import.meta.url));

export default defineConfig({
  testDir: './tests',
  globalSetup: globalSetupPath,
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
      testIgnore: /shell-state-provider-restore\.spec\.ts/
    },
    {
      name: 'chromium-dev',
      use: {
        browserName: 'chromium',
        baseURL: devBaseUrl,
        trace: DEFAULT_TRACE_MODE
      },
      testMatch: /shell-state-provider-restore\.spec\.ts|progression-baseline\.spec\.ts/
    }
  ]
});
