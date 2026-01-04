import {promises as fs} from 'node:fs';
import path from 'node:path';

const ARTIFACT_ROOT = path.join('artifacts', 'benchmarks');
const BENCHMARK_EVENT = 'benchmark_run_end';

export type BenchmarkEnv = {
  nodeVersion: string | null;
  platform: string | null;
  arch: string | null;
  commitSha: string | null;
};

export type BenchmarkPayload = {
  event: string;
  schemaVersion: number;
  benchmark: {name: string};
  config: Record<string, unknown>;
  results: Record<string, unknown>;
  env: BenchmarkEnv;
};

export type BenchmarkArtifact = {
  packageName: string;
  filePath: string;
  payload: BenchmarkPayload;
};

export async function collectBenchmarkArtifacts(): Promise<BenchmarkArtifact[]> {
  if (!(await exists(ARTIFACT_ROOT))) {
    throw new Error('No benchmark artifacts found. Run pnpm perf:md before aggregating.');
  }

  const files: string[] = [];
  await walk(ARTIFACT_ROOT, async (filePath) => {
    if (filePath.endsWith('.json')) {
      files.push(filePath);
    }
  });

  if (files.length === 0) {
    throw new Error('No benchmark artifacts found. Run pnpm perf:md before aggregating.');
  }

  const artifacts = [];
  const sortedFiles = [...files].sort((a, b) => a.localeCompare(b));
  for (const filePath of sortedFiles) {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const payload = parseBenchmarkPayload(raw, filePath);
    const packageName = derivePackageName(filePath);
    artifacts.push({packageName, filePath, payload});
  }

  return artifacts;
}

export function renderMarkdown(artifacts: BenchmarkArtifact[]): string {
  if (artifacts.length === 0) {
    throw new Error('No benchmark artifacts found. Run pnpm perf:md before aggregating.');
  }

  const grouped = groupByBenchmark(artifacts);
  const lines = [
    '---',
    'title: Performance Report',
    'sidebar_label: Performance Report',
    '---',
    '',
    '# Performance Report',
    '',
    'Run `pnpm perf:md` from the repository root to regenerate this page after modifying benchmarks.',
    'Benchmark artifacts are generated in `artifacts/benchmarks/` and are ignored by git.',
    ''
  ];

  for (const [benchmarkName, runs] of grouped) {
    lines.push(`## ${benchmarkName}`);
    const sortedRuns = [...runs].sort((a, b) => a.packageName.localeCompare(b.packageName));

    for (const run of sortedRuns) {
      lines.push(`### ${run.packageName}`);
      lines.push(...renderRunDetails(run));
      lines.push('');
      lines.push(...renderBenchmarkResults(benchmarkName, run.payload));
      lines.push('');
    }
  }

  return lines.join('\n');
}

function groupByBenchmark(artifacts: BenchmarkArtifact[]): Array<[string, BenchmarkArtifact[]]> {
  const grouped = new Map<string, BenchmarkArtifact[]>();
  for (const artifact of artifacts) {
    const name = artifact.payload.benchmark.name;
    const bucket = grouped.get(name);
    if (bucket) {
      bucket.push(artifact);
    } else {
      grouped.set(name, [artifact]);
    }
  }

  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function renderRunDetails(artifact: BenchmarkArtifact): string[] {
  const {payload} = artifact;
  const details: Array<[string, string]> = [
    ['Commit', formatDetailValue(payload.env.commitSha)],
    ['Node', formatDetailValue(payload.env.nodeVersion)],
    ['Platform', formatDetailValue(payload.env.platform)],
    ['Arch', formatDetailValue(payload.env.arch)],
    ...formatConfigDetails(payload.benchmark.name, payload.config)
  ];

  return [
    '#### Run Details',
    '| Detail | Value |',
    '| --- | --- |',
    ...details.map(([key, value]) => formatRow([key, value]))
  ];
}

function renderBenchmarkResults(benchmarkName: string, payload: BenchmarkPayload): string[] {
  if (benchmarkName === 'event-frame-format') {
    return renderEventFrameFormat(payload.results);
  }
  if (benchmarkName === 'diagnostic-timeline-overhead') {
    return renderDiagnosticTimelineOverhead(payload.results);
  }
  if (benchmarkName === 'state-sync-checksum') {
    return renderStateSyncChecksum(payload.results);
  }
  if (benchmarkName === 'runtime-workload-sim') {
    return renderRuntimeWorkload(payload.results);
  }

  return renderUnknownBenchmark(payload.results);
}

function renderEventFrameFormat(results: Record<string, unknown>): string[] {
  const scenarios = readArray(results.scenarios);
  if (scenarios.length === 0) {
    return ['_No scenarios reported._'];
  }

  const rows = scenarios.map((scenario) => {
    const record = asRecord(scenario) ?? {};
    const label = readString(record.label) ?? 'unknown';
    const eventsPerTick = formatCount(readNumber(record.eventsPerTick));
    const formats = asRecord(record.formats) ?? {};
    const structStats = readStats(formats['struct-of-arrays']);
    const objectStats = readStats(formats['object-array']);
    const ratios = asRecord(record.ratios) ?? {};

    let ratioMean = readNumber(ratios.objectOverStructMean);
    if (ratioMean === null && structStats.meanMs !== null && objectStats.meanMs !== null) {
      ratioMean = structStats.meanMs === 0 ? null : objectStats.meanMs / structStats.meanMs;
    }

    return formatRow([
      label,
      eventsPerTick,
      formatMs(structStats.meanMs),
      formatMs(structStats.medianMs),
      formatHz(structStats.hz),
      formatMs(objectStats.meanMs),
      formatMs(objectStats.medianMs),
      formatHz(objectStats.hz),
      formatRatio(ratioMean)
    ]);
  });

  return [
    '#### Scenarios',
    '| Scenario | Events/Tick | Struct Mean (ms) | Struct Median (ms) | Struct Hz | Object Mean (ms) | Object Median (ms) | Object Hz | Mean Ratio (object/struct) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows
  ];
}

function renderDiagnosticTimelineOverhead(results: Record<string, unknown>): string[] {
  const tasks = readArray(results.tasks);
  if (tasks.length === 0) {
    return ['_No tasks reported._'];
  }

  const rows = tasks.map((task) => {
    const record = asRecord(task) ?? {};
    const name = readString(record.name) ?? 'unknown';
    const diagnosticsEnabled = readBoolean(record.diagnosticsEnabled);
    const stats = readStats(record.stats);
    const rme = readNumber((asRecord(record.stats) ?? {}).rmePercent);
    const samples = readNumber((asRecord(record.stats) ?? {}).samples);

    return formatRow([
      name,
      formatDetailValue(diagnosticsEnabled),
      formatMs(stats.meanMs),
      formatMs(stats.medianMs),
      formatHz(stats.hz),
      formatPercent(rme),
      formatCount(samples)
    ]);
  });

  const ratios = asRecord(results.ratios) ?? {};
  const meanRatio = formatRatio(readNumber(ratios.enabledOverDisabledMean));
  const medianRatio = formatRatio(readNumber(ratios.enabledOverDisabledMedian));

  return [
    '#### Tasks',
    '| Task | Diagnostics Enabled | Mean (ms) | Median (ms) | Hz | RME (%) | Samples |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Overhead ratio (enabled/disabled): mean ${meanRatio}x, median ${medianRatio}x.`
  ];
}

function renderStateSyncChecksum(results: Record<string, unknown>): string[] {
  const scenarios = readArray(results.scenarios);
  if (scenarios.length === 0) {
    return ['_No scenarios reported._'];
  }

  const rows = scenarios.map((scenario) => {
    const record = asRecord(scenario) ?? {};
    const label = readString(record.label) ?? 'unknown';
    const shape = formatShape(asRecord(record.shape));
    const stats = readStats(record.stats);
    const targetUs = readNumber(record.targetUs);
    const meanUs = stats.meanMs === null ? null : stats.meanMs * 1000;
    const medianUs = stats.medianMs === null ? null : stats.medianMs * 1000;
    const minUs = stats.minMs === null ? null : stats.minMs * 1000;
    const maxUs = stats.maxMs === null ? null : stats.maxMs * 1000;
    let meanOverTarget = readNumber(record.meanOverTarget);
    if (meanOverTarget === null && meanUs !== null && targetUs !== null && targetUs !== 0) {
      meanOverTarget = meanUs / targetUs;
    }
    const status = readString(record.status) ?? 'unknown';

    return formatRow([
      label,
      shape,
      formatUs(meanUs),
      formatUs(medianUs),
      formatUs(minUs),
      formatUs(maxUs),
      formatCount(targetUs),
      formatRatio(meanOverTarget),
      status
    ]);
  });

  return [
    '#### Scenarios',
    '| Scenario | Shape | Mean (us) | Median (us) | Min (us) | Max (us) | Target (us) | Mean/Target | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows
  ];
}

function renderRuntimeWorkload(results: Record<string, unknown>): string[] {
  const scenarios = readArray(results.scenarios);
  if (scenarios.length === 0) {
    return ['_No scenarios reported._'];
  }

  const rows = scenarios.map((scenario) => {
    const record = asRecord(scenario) ?? {};
    const label = readString(record.label) ?? 'unknown';
    const stats = readStats(record.stats);
    const diagnostics = asRecord(record.diagnostics) ?? {};
    const slowTickCount = readNumber(diagnostics.slowTickCount);
    const maxQueueBacklog = readNumber(diagnostics.maxQueueBacklog);
    const dropped = readNumber(diagnostics.dropped);
    const snapshot = asRecord(record.snapshot) ?? {};
    const snapshotBytes = readNumber(snapshot.bytes);
    const memory = asRecord(record.memory) ?? {};
    const rss = readNumber(memory.rss);

    return formatRow([
      label,
      formatMs(stats.meanMs),
      formatMs(stats.medianMs),
      formatMs(stats.maxMs),
      formatCount(slowTickCount),
      formatCount(maxQueueBacklog),
      formatCount(dropped),
      formatKilobytes(snapshotBytes),
      formatMegabytes(rss)
    ]);
  });

  return [
    '#### Scenarios',
    '| Scenario | Mean (ms) | Median (ms) | Max (ms) | Slow Ticks | Max Queue Backlog | Dropped | Snapshot (KB) | RSS (MB) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows
  ];
}

function renderUnknownBenchmark(results: Record<string, unknown>): string[] {
  return [
    '#### Results',
    'Unsupported benchmark schema. Extend tools/perf-report to render this benchmark.',
    '',
    '```json',
    JSON.stringify(results, null, 2),
    '```'
  ];
}

function formatConfigDetails(
  benchmarkName: string,
  config: Record<string, unknown>
): Array<[string, string]> {
  const details: Array<[string, string]> = [];
  const cfg = asRecord(config) ?? {};

  if (benchmarkName === 'event-frame-format') {
    pushDetail(details, 'Config: Iterations', readNumber(cfg.iterations));
    const scenarioCount = readArray(cfg.scenarios).length || null;
    pushDetail(details, 'Config: Scenarios', scenarioCount);
  } else if (benchmarkName === 'diagnostic-timeline-overhead') {
    pushDetail(details, 'Config: Step Size (ms)', readNumber(cfg.stepSizeMs));
    pushDetail(details, 'Config: Warmup Ticks', readNumber(cfg.warmupTicks));
    pushDetail(details, 'Config: Measure Ticks', readNumber(cfg.measureTicks));
    pushDetail(details, 'Config: Commands/Tick', readNumber(cfg.commandsPerTick));
    pushDetail(details, 'Config: Events/Tick', readNumber(cfg.eventsPerTick));
    pushDetail(details, 'Config: Command Iterations', readNumber(cfg.commandIterations));
    pushDetail(details, 'Config: Heavy System Iterations', readNumber(cfg.heavySystemIterations));
    const benchCfg = asRecord(cfg.bench) ?? {};
    pushDetail(details, 'Config: Bench Time (ms)', readNumber(benchCfg.time));
    pushDetail(details, 'Config: Bench Iterations', readNumber(benchCfg.iterations));
    pushDetail(details, 'Config: Bench Warmup Time (ms)', readNumber(benchCfg.warmupTime));
    pushDetail(details, 'Config: Bench Warmup Iterations', readNumber(benchCfg.warmupIterations));
  } else if (benchmarkName === 'state-sync-checksum') {
    pushDetail(details, 'Config: Warmup Iterations', readNumber(cfg.warmupIterations));
    pushDetail(details, 'Config: Measure Iterations', readNumber(cfg.measureIterations));
    pushDetail(details, 'Config: Runs', readNumber(cfg.runs));
    pushDetail(details, 'Config: Target (us)', readNumber(cfg.targetUs));
    pushDetail(details, 'Config: Enforce Target', readBoolean(cfg.enforceTarget));
  } else if (benchmarkName === 'runtime-workload-sim') {
    pushDetail(details, 'Config: Step Size (ms)', readNumber(cfg.stepSizeMs));
    pushDetail(details, 'Config: Warmup Ticks', readNumber(cfg.warmupTicks));
    pushDetail(details, 'Config: Measure Ticks', readNumber(cfg.measureTicks));
    pushDetail(details, 'Config: Seed', readNumber(cfg.seed));
    pushDetail(details, 'Config: Max Steps/Frame', readNumber(cfg.maxStepsPerFrame));
    const scenarioCount = readArray(cfg.scenarios).length || null;
    pushDetail(details, 'Config: Scenarios', scenarioCount);
    pushDetail(details, 'Config: Include Memory', readBoolean(cfg.includeMemory));
  }

  return details;
}

function pushDetail(
  details: Array<[string, string]>,
  label: string,
  value: number | boolean | null
): void {
  if (value === null) {
    return;
  }
  details.push([label, formatDetailValue(value)]);
}

function parseBenchmarkPayload(raw: unknown, filePath: string): BenchmarkPayload {
  if (!asRecord(raw)) {
    throw new Error(`Benchmark artifact at ${filePath} is not a JSON object.`);
  }

  if (raw.event !== BENCHMARK_EVENT) {
    throw new Error(`Benchmark artifact at ${filePath} has unexpected event "${String(raw.event)}".`);
  }

  const benchmark = asRecord(raw.benchmark);
  const name = readString(benchmark?.name);
  if (!name) {
    throw new Error(`Benchmark artifact at ${filePath} is missing benchmark.name.`);
  }

  const config = asRecord(raw.config);
  const results = asRecord(raw.results);
  if (!config || !results) {
    throw new Error(`Benchmark artifact at ${filePath} is missing config/results.`);
  }

  const env = normalizeEnv(raw.env);

  return {
    event: String(raw.event),
    schemaVersion: readNumber(raw.schemaVersion) ?? 0,
    benchmark: {name},
    config,
    results,
    env
  };
}

function normalizeEnv(rawEnv: unknown): BenchmarkEnv {
  const env = asRecord(rawEnv) ?? {};
  return {
    nodeVersion: readString(env.nodeVersion),
    platform: readString(env.platform),
    arch: readString(env.arch),
    commitSha: readString(env.commitSha)
  };
}

function derivePackageName(filePath: string): string {
  const relative = path.relative(ARTIFACT_ROOT, filePath);
  const dir = path.dirname(relative);
  if (dir === '.' || dir === '') {
    return 'unknown';
  }
  return dir.split(path.sep).join('/');
}

function formatRow(cells: string[]): string {
  return `| ${cells.map(escapeTable).join(' | ')} |`;
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function formatDetailValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return 'n/a';
}

function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return String(value);
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(4);
}

function formatHz(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(2);
}

function formatUs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(2);
}

function formatKilobytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return (value / 1024).toFixed(2);
}

function formatMegabytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return (value / (1024 * 1024)).toFixed(2);
}

function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(3);
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(2);
}

function formatShape(shape: Record<string, unknown> | null): string {
  if (!shape) {
    return 'n/a';
  }
  return [
    `R${formatShapeCount(readNumber(shape.resources))}`,
    `G${formatShapeCount(readNumber(shape.generators))}`,
    `U${formatShapeCount(readNumber(shape.upgrades))}`,
    `Ach${formatShapeCount(readNumber(shape.achievements))}`,
    `Auto${formatShapeCount(readNumber(shape.automations))}`,
    `Tr${formatShapeCount(readNumber(shape.transforms))}`,
    `Cmd${formatShapeCount(readNumber(shape.commands))}`
  ].join(' ');
}

function formatShapeCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '?';
  }
  return String(value);
}

function readStats(value: unknown): {
  meanMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  hz: number | null;
} {
  const record = asRecord(value) ?? {};
  return {
    meanMs: readNumber(record.meanMs),
    medianMs: readNumber(record.medianMs),
    minMs: readNumber(record.minMs),
    maxMs: readNumber(record.maxMs),
    hz: readNumber(record.hz)
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function walk(
  dir: string,
  visitor: (filePath: string) => Promise<void> | void
): Promise<void> {
  const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visitor);
    } else if (entry.isFile()) {
      await visitor(fullPath);
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
