import { spawnSync } from 'node:child_process';

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

const runPnpm = (args, env = {}) => {
  const result = spawnSync(getPnpmCommand(), args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ...env,
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pnpm ${args[0]} failed with exit code ${result.status}`);
  }
};

runPnpm(['generate']);
runPnpm(['--filter', '@idle-engine/shell-desktop...', 'build']);
runPnpm(
  ['--filter', '@idle-engine/shell-desktop', 'exec', 'electron', './dist/main.js'],
  { IDLE_ENGINE_GAME: 'test-game' },
);
