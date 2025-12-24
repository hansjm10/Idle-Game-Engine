import { execSync } from 'node:child_process';

const baseRef = process.env.FAST_BASE_REF ?? 'origin/main';
const scope = process.env.FAST_SCOPE ?? 'auto';

const readLines = (command) => {
  const output = execSync(command, { encoding: 'utf8' }).trim();
  if (!output) {
    return [];
  }
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
};

const stagedFiles = readLines('git diff --name-only --cached');
const useStaged = scope === 'staged' || (scope === 'auto' && stagedFiles.length > 0);

let changedFiles = [];
if (useStaged) {
  changedFiles = stagedFiles;
} else {
  let mergeBase = '';
  try {
    mergeBase = execSync(`git merge-base HEAD ${baseRef}`, { encoding: 'utf8' }).trim();
  } catch {
    mergeBase = 'HEAD';
  }

  changedFiles = readLines(`git diff --name-only ${mergeBase}`);
}

if (changedFiles.length === 0) {
  console.log('lint:fast: no changes detected; skipping.');
  process.exit(0);
}

const isLintConfigChange = (file) => {
  if (file === 'eslint.config.mjs') {
    return true;
  }

  if (file === 'package.json' || file === 'pnpm-lock.yaml' || file === 'pnpm-workspace.yaml') {
    return true;
  }

  if (file === 'tsconfig.base.json' || file.startsWith('tsconfig')) {
    return true;
  }

  if (file.startsWith('packages/config-')) {
    return true;
  }

  return false;
};

if (changedFiles.some(isLintConfigChange)) {
  console.log('lint:fast: lint config touched; running full pnpm lint.');
  execSync('pnpm lint', { stdio: 'inherit' });
  process.exit(0);
}

const eslintTargets = [];
const eslintExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs']);
let shouldLintDocGuide = false;

for (const file of changedFiles) {
  if (file === 'docs/content-dsl-usage-guidelines-design.md') {
    shouldLintDocGuide = true;
    continue;
  }

  const extIndex = file.lastIndexOf('.');
  if (extIndex === -1) {
    continue;
  }

  const ext = file.slice(extIndex);
  if (!eslintExtensions.has(ext)) {
    continue;
  }

  eslintTargets.push(file);
}

if (eslintTargets.length > 0) {
  const lintCommand = [
    'pnpm',
    'exec',
    'eslint',
    '--max-warnings=0',
    '--cache',
    '--cache-location',
    '.cache/eslint',
    ...eslintTargets
  ];
  execSync(lintCommand.join(' '), { stdio: 'inherit' });
} else {
  console.log('lint:fast: no eslint targets detected; skipping eslint.');
}

if (shouldLintDocGuide) {
  execSync(
    'pnpm exec markdownlint --config packages/docs/.markdownlint.jsonc docs/content-dsl-usage-guidelines-design.md',
    { stdio: 'inherit' }
  );
  execSync(
    'pnpm exec markdown-link-check --config packages/docs/markdown-link-check.json docs/content-dsl-usage-guidelines-design.md',
    { stdio: 'inherit' }
  );
} else {
  console.log('lint:fast: docs/content-dsl-usage-guidelines-design.md unchanged; skipping markdown checks.');
}
