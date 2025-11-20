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
const SHELL_WEB_DIST_ASSETS = path.join(
  MONOREPO_ROOT,
  'packages',
  'shell-web',
  'dist',
  'assets'
);
const shellWebBuildExists = fs.existsSync(SHELL_WEB_DIST_INDEX);
const economyPreviewFlagBaked = shellWebBuildExists && distIncludesEconomyPreviewFlag();

if (shouldSkipBuild) {
  console.log('[a11y-pretest] PLAYWRIGHT_A11Y_SKIP_BUILD set; skipping core/shell builds.');
  process.exit(0);
}

if (isCI && shellWebBuildExists && economyPreviewFlagBaked) {
  console.log('[a11y-pretest] CI detected; shell-web dist already includes economy preview flag. Skipping rebuild.');
  process.exit(0);
}

function coerceBoolean(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function distIncludesEconomyPreviewFlag() {
  try {
    const assetFiles = fs.readdirSync(SHELL_WEB_DIST_ASSETS).filter((file) => file.endsWith('.js'));
    const truthyFlagPattern = /VITE_ENABLE_ECONOMY_PREVIEW["']?\s*:\s*(?:true|!0|1|"1"|'1'|"true"|'true')/;

    return assetFiles.some((file) => {
      const contents = fs.readFileSync(path.join(SHELL_WEB_DIST_ASSETS, file), 'utf8');
      return truthyFlagPattern.test(contents);
    });
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: MONOREPO_ROOT,
    env: { ...process.env, VITE_ENABLE_ECONOMY_PREVIEW: '1' },
    ...opts
  });
  if (res.error) {
    console.error(res.error);
    process.exit(res.status ?? 1);
  }
  if (res.status !== 0) {
    process.exit(res.status);
  }
}

if (isCI) {
  console.log('[a11y-pretest] CI detected; rebuilding preview assets to bake VITE_ENABLE_ECONOMY_PREVIEW=1.');
} else {
  console.log('[a11y-pretest] Building @idle-engine/core and @idle-engine/shell-web for preview...');
}
run('pnpm', ['--filter', '@idle-engine/core', 'run', 'build']);
run('pnpm', ['--filter', '@idle-engine/shell-web', 'run', 'build']);
console.log('[a11y-pretest] Build complete.');
