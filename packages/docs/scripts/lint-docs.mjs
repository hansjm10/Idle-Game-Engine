import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const eslintConfig = path.resolve(__dirname, '../eslint.config.mjs');

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'eslint',
    '--config',
    path.relative(repoRoot, eslintConfig),
    'docs',
    '--ext',
    'md,mdx',
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status);
}
