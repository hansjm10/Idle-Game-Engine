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
  console.log('test:fast: no changes detected; skipping.');
  process.exit(0);
}

const affectedPackages = new Set();
let requiresFull = false;

const addContentSuite = () => {
  affectedPackages.add('@idle-engine/content-compiler');
  affectedPackages.add('@idle-engine/content-schema');
  affectedPackages.add('@idle-engine/content-sample');
  affectedPackages.add('@idle-engine/content-validation-cli');
};

const isConfigChange = (file) => {
  if (file === 'package.json' || file === 'pnpm-lock.yaml' || file === 'pnpm-workspace.yaml') {
    return true;
  }

  if (file === 'eslint.config.mjs' || file === 'lefthook.yml') {
    return true;
  }

  if (file === 'tsconfig.base.json' || file.startsWith('tsconfig')) {
    return true;
  }

  if (file.startsWith('.github/workflows/')) {
    return true;
  }

  if (file.startsWith('packages/config-')) {
    return true;
  }

  if (file.startsWith('tools/scripts/')) {
    return true;
  }

  return false;
};

for (const file of changedFiles) {
  if (isConfigChange(file)) {
    requiresFull = true;
    continue;
  }

  if (file.startsWith('packages/core/')) {
    affectedPackages.add('@idle-engine/core');
    continue;
  }

  if (file.startsWith('packages/runtime-bridge-contracts/')) {
    affectedPackages.add('@idle-engine/runtime-bridge-contracts');
    continue;
  }

  if (file.startsWith('packages/shell-web/')) {
    affectedPackages.add('@idle-engine/shell-web');
    continue;
  }

  if (file.startsWith('tools/a11y-smoke-tests/')) {
    affectedPackages.add('@idle-engine/a11y-smoke-tests');
    continue;
  }

  if (file.startsWith('services/social/')) {
    affectedPackages.add('@idle-engine/social-service');
    continue;
  }

  if (file.startsWith('content/')) {
    addContentSuite();
    continue;
  }

  if (file.startsWith('packages/content-') || file.startsWith('tools/content-')) {
    addContentSuite();
    continue;
  }
}

if (requiresFull) {
  console.log('test:fast: shared config touched; running full test:ci.');
  execSync('pnpm test:ci', { stdio: 'inherit' });
  process.exit(0);
}

if (affectedPackages.size === 0) {
  console.log('test:fast: no test packages matched changes; skipping.');
  process.exit(0);
}

const filterArgs = [];
for (const pkg of affectedPackages) {
  filterArgs.push('--filter', pkg);
}

const command = ['pnpm', ...filterArgs, 'run', '--if-present', 'test:ci'];
console.log(`test:fast: running ${[...affectedPackages].join(', ')}.`);
execSync(command.join(' '), { stdio: 'inherit' });
