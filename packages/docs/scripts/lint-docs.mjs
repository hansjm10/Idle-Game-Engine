import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const eslintConfig = path.resolve(__dirname, '../eslint.config.mjs');
const markdownlintConfig = path.resolve(__dirname, '../.markdownlint.jsonc');
const linkCheckConfig = path.resolve(__dirname, '../markdown-link-check.json');
const targetDoc = path.resolve(
  repoRoot,
  'docs/content-dsl-usage-guidelines-design.md',
);
const targetDocRelative = path.relative(repoRoot, targetDoc);

const commands = [
  [
    'exec',
    'eslint',
    '--config',
    path.relative(repoRoot, eslintConfig),
    'docs',
    '--ext',
    'md,mdx',
  ],
  [
    'exec',
    'markdownlint',
    '--config',
    path.relative(repoRoot, markdownlintConfig),
    targetDocRelative,
  ],
  [
    'exec',
    'markdown-link-check',
    '--config',
    path.relative(repoRoot, linkCheckConfig),
    targetDocRelative,
  ],
];

for (const args of commands) {
  const result = spawnSync('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}
