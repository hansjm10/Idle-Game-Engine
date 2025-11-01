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
    '--max-warnings=0',
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

  const exitCode = typeof result.status === 'number' ? result.status : null;

  if (exitCode === null || exitCode !== 0) {
    // Fail fast so markdown lint/link errors surface in pnpm and Lefthook runs.
    process.exit(exitCode ?? 1);
  }
}
