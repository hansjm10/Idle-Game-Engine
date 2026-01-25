import { execFileSync } from 'node:child_process';

const PNPM_EXEC_PATH = process.env.npm_execpath;
if (typeof PNPM_EXEC_PATH !== 'string' || PNPM_EXEC_PATH.length === 0) {
  throw new Error('play-test-game.mjs must be run via pnpm (use `pnpm test-game:play`).');
}

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const runPnpm = (args, env = {}) => {
  execFileSync(process.execPath, [PNPM_EXEC_PATH, ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...env,
      PATH: SAFE_PATH,
    },
  });
};

runPnpm(['generate']);
runPnpm(['--filter', '@idle-engine/shell-desktop...', 'build']);
runPnpm(
  ['--filter', '@idle-engine/shell-desktop', 'exec', 'electron', './dist/main.js'],
  { IDLE_ENGINE_GAME: 'test-game' },
);
