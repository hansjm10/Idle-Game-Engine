import { execSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

const baseRef = process.env.FAST_BASE_REF ?? 'origin/main';
const scope = process.env.FAST_SCOPE ?? 'auto';

const readLines = (command) => {
  const output = execSync(command, { encoding: 'utf8' }).trim();
  if (!output) {
    return [];
  }
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
};

const repoRoot = process.cwd();
const toRelatedPath = (file) => resolve(repoRoot, file).split(sep).join('/');

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
const relatedFilesByPackage = new Map();
let requiresFull = false;

const addRelatedFile = (pkg, file) => {
  const relatedFiles = relatedFilesByPackage.get(pkg);
  if (relatedFiles) {
    relatedFiles.add(file);
  } else {
    relatedFilesByPackage.set(pkg, new Set([file]));
  }
};

const contentPackages = [
  '@idle-engine/content-compiler',
  '@idle-engine/content-schema',
  '@idle-engine/content-sample',
  '@idle-engine/content-validation-cli'
];

const addContentSuite = (file) => {
  for (const pkg of contentPackages) {
    affectedPackages.add(pkg);
    addRelatedFile(pkg, file);
  }
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
    addRelatedFile('@idle-engine/core', file);
    continue;
  }

  if (file.startsWith('tools/economy-verification/')) {
    affectedPackages.add('@idle-engine/economy-verification-cli');
    addRelatedFile('@idle-engine/economy-verification-cli', file);
    continue;
  }

  if (file.startsWith('content/')) {
    addContentSuite(file);
    continue;
  }

  if (file.startsWith('packages/content-') || file.startsWith('tools/content-')) {
    addContentSuite(file);
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

const vitestPackages = [...affectedPackages];

const runVitestPackages = (packages) => {
  for (const pkg of packages) {
    const relatedFiles = relatedFilesByPackage.get(pkg);
    if (!relatedFiles || relatedFiles.size === 0) {
      console.log(`test:fast: no related files detected for ${pkg}; skipping.`);
      continue;
    }

    const relatedArgs = [...relatedFiles].map(toRelatedPath);
    const command = ['pnpm', '--filter', pkg, 'exec', 'vitest', 'related', ...relatedArgs];
    console.log(`test:fast: running ${pkg} (vitest related).`);
    execSync(command.join(' '), { stdio: 'inherit' });
  }
};

runVitestPackages(vitestPackages);
