import { execSync } from 'node:child_process';

execSync('pnpm generate', { stdio: 'inherit' });

execSync('pnpm --filter @idle-engine/shell-desktop... build', { stdio: 'inherit' });

execSync('pnpm --filter @idle-engine/shell-desktop exec electron ./dist/main.js', {
  stdio: 'inherit',
  env: {
    ...process.env,
    IDLE_ENGINE_GAME: 'test-game',
  },
});
