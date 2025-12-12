#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const skipDownload = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;

if (isEnvTruthy(skipDownload)) {
  console.log('Skipping Playwright browser download because PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set.');
  process.exit(0);
}

const isCI = process.env.CI === 'true' || process.env.CI === '1';
const installArgs = ['exec', 'playwright', 'install', 'chromium'];

const shouldTryWithDeps = isCI && process.platform === 'linux';

try {
  if (shouldTryWithDeps) {
    const withDepsStatus = run([...installArgs, '--with-deps']);
    if (withDepsStatus === 0) {
      process.exit(0);
    }

    console.warn(
      'Playwright dependency install failed; retrying browser install without OS dependencies.'
    );
  }

  const installStatus = run(installArgs);
  if (installStatus !== 0) {
    process.exit(installStatus);
  }
} catch (error) {
  console.warn('Playwright browser install failed. If browsers are already available locally, this warning can be ignored.');
  process.exit(1);
}

function isEnvTruthy(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

function run(commandArgs) {
  const res = spawnSync('pnpm', commandArgs, { stdio: 'inherit' });

  if (res.error) {
    throw res.error;
  }

  return res.status ?? 1;
}
