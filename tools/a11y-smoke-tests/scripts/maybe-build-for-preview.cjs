#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isCI = process.env.CI === 'true' || process.env.CI === '1';
const shouldSkipBuild = coerceBoolean(
  process.env.PLAYWRIGHT_A11Y_SKIP_BUILD ?? process.env.PLAYWRIGHT_SKIP_BUILD
);
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');
const SHELL_WEB_DIST_INDEX = path.join(
  MONOREPO_ROOT,
  'packages',
  'shell-web',
  'dist',
  'index.html'
);
const shellWebBuildExists = fs.existsSync(SHELL_WEB_DIST_INDEX);

if (shouldSkipBuild) {
  console.log('[a11y-pretest] PLAYWRIGHT_A11Y_SKIP_BUILD set; skipping core/shell builds.');
  process.exit(0);
}

if (isCI && shellWebBuildExists) {
  console.log('[a11y-pretest] CI detected; shell-web dist already built. Skipping rebuild.');
  process.exit(0);
}

function coerceBoolean(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: MONOREPO_ROOT, ...opts });
  if (res.error) {
    console.error(res.error);
    process.exit(res.status ?? 1);
  }
  if (res.status !== 0) {
    process.exit(res.status);
  }
}

if (isCI) {
  console.log('[a11y-pretest] CI detected but shell-web dist missing; building preview prerequisites...');
} else {
  console.log('[a11y-pretest] Building @idle-engine/core and @idle-engine/shell-web for preview...');
}
run('pnpm', ['--filter', '@idle-engine/core', 'run', 'build']);
run('pnpm', ['--filter', '@idle-engine/shell-web', 'run', 'build']);
console.log('[a11y-pretest] Build complete.');

