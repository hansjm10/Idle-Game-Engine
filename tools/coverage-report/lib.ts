import {promises as fs} from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOTS = ['packages', 'services', 'tools'];
const METRICS = ['statements', 'branches', 'functions', 'lines'] as const;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', '.parcel-cache']);

export type Metric = typeof METRICS[number];

export type CoverageCounts = {
  covered: number;
  total: number;
};

export type PackageSummary = {
  name: string;
  summary: Record<Metric, CoverageCounts>;
};

export type CoverageTotals = Record<Metric, CoverageCounts>;

const EMPTY_TOTALS: CoverageTotals = METRICS.reduce(
  (acc, metric) => {
    acc[metric] = {covered: 0, total: 0};
    return acc;
  },
  {} as CoverageTotals
);

export async function collectPackageSummaries(): Promise<PackageSummary[]> {
  const summaries: PackageSummary[] = [];
  const seen = new Set<string>();

  for (const root of WORKSPACE_ROOTS) {
    if (!(await exists(root))) {
      continue;
    }

    await walk(root, async (direntPath) => {
      if (path.basename(direntPath) !== 'coverage') {
        return;
      }

      const summaryPath = path.join(direntPath, 'coverage-summary.json');
      if (!(await exists(summaryPath))) {
        return;
      }

      const packageJsonPath = await findNearestPackageJson(path.dirname(direntPath));
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      const packageName = packageJson.name ?? packageJsonPath;

      if (seen.has(packageName)) {
        throw new Error(`Coverage already collected for ${packageName}; ensure only one coverage directory exists.`);
      }

      const summary = await parseCoverageSummary(summaryPath);
      summaries.push({name: packageName, summary});
      seen.add(packageName);
    });
  }

  if (summaries.length === 0) {
    throw new Error('No coverage artifacts found. Run pnpm coverage:md before aggregating.');
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export function aggregateTotals(packages: PackageSummary[]): CoverageTotals {
  const totals: CoverageTotals = structuredClone(EMPTY_TOTALS);

  for (const pkg of packages) {
    for (const metric of METRICS) {
      totals[metric].covered += pkg.summary[metric].covered;
      totals[metric].total += pkg.summary[metric].total;
    }
  }

  return totals;
}

type RenderMarkdownParams = {
  packages: PackageSummary[];
  totals: CoverageTotals;
};

export function renderMarkdown({packages, totals}: RenderMarkdownParams): string {
  const overallRows = METRICS.map((metric) => formatOverallRow(metric, totals[metric]));
  const packageRows = packages.map((pkg) => formatPackageRow(pkg));

  return [
    '---',
    'title: Coverage Report',
    'sidebar_label: Coverage Report',
    '---',
    '',
    '# Coverage Report',
    '',
    'Run `pnpm coverage:md` from the repository root to regenerate this page after modifying tests.',
    '',
    '## Overall Coverage',
    '| Metric | Covered | Total | % |',
    '| --- | --- | --- | --- |',
    ...overallRows,
    '',
    '## Coverage by Package',
    '| Package | Statements | Branches | Functions | Lines |',
    '| --- | --- | --- | --- | --- |',
    ...packageRows,
    ''
  ].join('\n');
}

function formatOverallRow(metric: Metric, counts: CoverageCounts): string {
  const pct = computePct(counts);
  return `| ${capitalize(metric)} | ${counts.covered} | ${counts.total} | ${pct} |`;
}

function formatPackageRow(pkg: PackageSummary): string {
  const cells = METRICS.map((metric) => {
    const counts = pkg.summary[metric];
    return `${counts.covered} / ${counts.total} (${computePct(counts)})`;
  });

  return `| ${pkg.name} | ${cells.join(' | ')} |`;
}

function computePct({covered, total}: CoverageCounts): string {
  if (total === 0) {
    return '0.00%';
  }
  return `${((covered / total) * 100).toFixed(2)}%`;
}

async function parseCoverageSummary(summaryPath: string): Promise<Record<Metric, CoverageCounts>> {
  const raw = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
  const totals = raw.total ?? raw;
  const summary: Record<Metric, CoverageCounts> = {} as Record<Metric, CoverageCounts>;

  for (const metric of METRICS) {
    if (!totals[metric]) {
      throw new Error(`Coverage summary at ${summaryPath} missing metric "${metric}".`);
    }
    summary[metric] = {
      covered: Number(totals[metric].covered ?? 0),
      total: Number(totals[metric].total ?? 0)
    };
  }

  return summary;
}

async function walk(dir: string, visitor: (direntPath: string) => Promise<void> | void): Promise<void> {
  const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      await visitor(fullPath);
      await walk(fullPath, visitor);
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function findNearestPackageJson(startDir: string): Promise<string> {
  let current = startDir;

  while (true) {
    const candidate = path.join(current, 'package.json');
    if (await exists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(`Unable to find package.json for coverage directory at ${startDir}`);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
