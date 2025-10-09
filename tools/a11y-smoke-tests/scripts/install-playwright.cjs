#!/usr/bin/env node

const { execSync } = require('node:child_process');

const skipDownload = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;

if (skipDownload && skipDownload !== '0' && skipDownload.toLowerCase?.() !== 'false') {
  console.log('Skipping Playwright browser download because PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set.');
  process.exit(0);
}

const isCI = process.env.CI === 'true' || process.env.CI === '1';
const args = ['pnpm', 'exec', 'playwright', 'install', 'chromium'];

if (isCI && process.platform === 'linux') {
  args.push('--with-deps');
}

try {
  execSync(args.join(' '), { stdio: 'inherit' });
} catch (error) {
  console.warn('Playwright browser install failed. If browsers are already available locally, this warning can be ignored.');
  process.exit(error.status ?? 1);
}
