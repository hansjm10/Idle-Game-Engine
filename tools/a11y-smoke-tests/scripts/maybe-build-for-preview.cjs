#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const isCI = process.env.CI === 'true' || process.env.CI === '1';

if (isCI) {
  console.log('[a11y-pretest] CI detected; skipping shell-web build (CI workflow builds workspace).');
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) {
    console.error(res.error);
    process.exit(res.status ?? 1);
  }
  if (res.status !== 0) {
    process.exit(res.status);
  }
}

console.log('[a11y-pretest] Building @idle-engine/core and @idle-engine/shell-web for preview...');
run('pnpm', ['--filter', '@idle-engine/core', 'run', 'build']);
run('pnpm', ['--filter', '@idle-engine/shell-web', 'run', 'build']);
console.log('[a11y-pretest] Build complete.');

