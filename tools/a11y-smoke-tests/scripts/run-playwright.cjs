#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const rawArgs = process.argv.slice(2);
const args = rawArgs.filter((arg) => arg !== '--');
const hasUiFlag = args.some((arg) => arg === '--ui' || arg.startsWith('--ui='));

if (hasUiFlag) {
  console.error('The Playwright UI (--ui) runner is disabled for these smoke tests.');
  process.exit(1);
}

const result = spawnSync('pnpm', ['exec', 'playwright', 'test', ...args], {
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);
