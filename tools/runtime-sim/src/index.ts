#!/usr/bin/env tsx
/*
 * Headless runtime simulator that advances the IdleEngineRuntime for N ticks
 * and prints the diagnostics timeline JSON to stdout. Scenario mode runs
 * workload simulations and emits a single-line benchmark summary JSON.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  CommandPriority,
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
  createGameRuntime,
  evaluateDiagnostics,
  resetRNG,
  setRNGSeed,
  summarizeDiagnostics,
  type DiagnosticTimelineResult,
  type DiagnosticsThresholds,
  type GameRuntimeWiring,
  type RuntimeDiagnosticsTimelineOptions,
} from '@idle-engine/core/internals';
import { sampleContent, type ContentPack } from '@idle-engine/content-sample';

const BENCHMARK_EVENT = 'benchmark_run_end';
const BENCHMARK_SCHEMA_VERSION = 1;
const DEFAULT_STEP_MS = 100;
const DEFAULT_SEED = 4242;
const DEFAULT_WARMUP_TICKS = 50;
const DEFAULT_MEASURE_TICKS = 300;

interface CliArgs {
  ticks?: number;
  stepMs: number;
  maxStepsPerFrame?: number;
  failOnSlow: boolean;
  queueBacklogCap?: number;
  slowTickBudgetMs?: number;
  scenarios: string[];
  warmupTicks?: number;
  measureTicks?: number;
  seed?: number;
  includeMemory: boolean;
  listScenarios: boolean;
  helpRequested: boolean;
}

type ScenarioDefinition = {
  id: string;
  label: string;
  description: string;
  seed: number;
  setup: (context: ScenarioContext) => void;
};

type ScenarioContext = {
  wiring: GameRuntimeWiring;
  content: ContentPack;
  stepSizeMs: number;
};

type ScenarioResult = {
  label: string;
  stepSizeMs: number;
  warmupTicks: number;
  measureTicks: number;
  stats: BenchmarkStats;
  diagnostics: {
    slowTickCount: number;
    maxQueueBacklog: number;
    maxTickDurationMs: number;
    avgTickDurationMs: number;
    dropped: number;
  };
  snapshot: {
    bytes: number;
    entries: number;
  };
  memory?: MemorySummary;
};

type BenchmarkStats = {
  meanMs: number | null;
  medianMs: number | null;
  stdDevMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  hz: number | null;
  samples: number;
  unit: 'ms';
};

type MemorySummary = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: 'sample-pack-baseline',
    label: 'sample-pack-baseline',
    description: 'Starter sample pack state with a single reactor.',
    seed: DEFAULT_SEED,
    setup: seedBaselineScenario,
  },
  {
    id: 'sample-pack-progression',
    label: 'sample-pack-progression',
    description: 'Seeded midgame state with automations and transforms active.',
    seed: DEFAULT_SEED,
    setup: seedProgressionScenario,
  },
];

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    stepMs: DEFAULT_STEP_MS,
    failOnSlow: false,
    scenarios: [],
    includeMemory: false,
    listScenarios: false,
    helpRequested: false,
  };

  const iterator = argv[Symbol.iterator]();
  for (let entry = iterator.next(); !entry.done; entry = iterator.next()) {
    const arg = entry.value;
    if (arg === '--ticks') {
      const next = iterator.next();
      args.ticks = Number(next.value);
    } else if (arg === '--step-ms') {
      const next = iterator.next();
      args.stepMs = Number(next.value);
    } else if (arg === '--max-steps-per-frame') {
      const next = iterator.next();
      args.maxStepsPerFrame = Number(next.value);
    } else if (arg === '--fail-on-slow') {
      args.failOnSlow = true;
    } else if (arg === '--queue-backlog-cap') {
      const next = iterator.next();
      args.queueBacklogCap = Number(next.value);
    } else if (arg === '--slow-tick-budget-ms') {
      const next = iterator.next();
      args.slowTickBudgetMs = Number(next.value);
    } else if (arg === '--scenario' || arg === '--scenarios') {
      const next = iterator.next();
      const value = next.value;
      if (value) {
        args.scenarios.push(
          ...value
            .split(',')
            .map((entryValue) => entryValue.trim())
            .filter((entryValue) => entryValue.length > 0),
        );
      }
    } else if (arg === '--warmup-ticks') {
      const next = iterator.next();
      args.warmupTicks = Number(next.value);
    } else if (arg === '--measure-ticks') {
      const next = iterator.next();
      args.measureTicks = Number(next.value);
    } else if (arg === '--seed') {
      const next = iterator.next();
      args.seed = Number(next.value);
    } else if (arg === '--include-memory') {
      args.includeMemory = true;
    } else if (arg === '--list-scenarios') {
      args.listScenarios = true;
    } else if (arg === '--help' || arg === '-h') {
      args.helpRequested = true;
    }
  }

  return args;
}

function printHelpAndExit(code: number): never {
  // Keep stdout clean for JSON consumers; print help on stderr.
  console.error(
      `Usage: pnpm core:tick-sim --ticks <n> [options]\n` +
      `       pnpm core:tick-sim --scenario <id>[,<id>...] [options]\n\n` +
      `Options:\n` +
      `  --ticks <n>                 Number of ticks to execute (legacy) or measure ticks (scenario)\n` +
      `  --step-ms <ms>              Step size in milliseconds (default: 100)\n` +
      `  --max-steps-per-frame <n>   Clamp steps per frame (legacy mode default: 50)\n` +
      `  --slow-tick-budget-ms <ms>  Slow tick budget (defaults to step size)\n` +
      `  --fail-on-slow              Exit non-zero when any tick exceeds budget\n` +
      `  --queue-backlog-cap <n>     Exit non-zero if queue backlog exceeds <n>\n` +
      `  --scenario <id>             Run workload scenario (repeatable or comma-separated)\n` +
      `  --warmup-ticks <n>          Warmup ticks before measuring (default: 50)\n` +
      `  --measure-ticks <n>         Measured ticks per scenario (default: 300)\n` +
      `  --seed <n>                  RNG seed override (default: 4242)\n` +
      `  --include-memory            Include process.memoryUsage() in output\n` +
      `  --list-scenarios            List available scenarios and exit\n` +
      `  -h, --help                  Show this help text`,
  );
  process.exit(code);
}

function printScenarioList(): void {
  console.error('Available scenarios:');
  for (const scenario of SCENARIOS) {
    console.error(`  ${scenario.id} - ${scenario.description}`);
  }
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Error: ${label} must be a positive integer`);
    printHelpAndExit(2);
  }
}

function assertPositiveNumber(value: number | undefined, label: string): void {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    console.error(`Error: ${label} must be a positive number`);
    printHelpAndExit(2);
  }
}

function assertNonNegativeInteger(value: number | undefined, label: string): void {
  if (!Number.isInteger(value) || (value ?? 0) < 0) {
    console.error(`Error: ${label} must be a non-negative integer`);
    printHelpAndExit(2);
  }
}

function resolveScenarios(selected: string[]): ScenarioDefinition[] {
  if (selected.includes('all')) {
    return [...SCENARIOS];
  }

  const resolved: ScenarioDefinition[] = [];
  for (const id of selected) {
    const match = SCENARIOS.find((scenario) => scenario.id === id);
    if (!match) {
      console.error(`Error: Unknown scenario "${id}".`);
      printHelpAndExit(2);
    }
    resolved.push(match);
  }

  return resolved;
}

function ensureResourceFloor(
  content: ContentPack,
  wiring: GameRuntimeWiring,
  resourceId: string,
  amount: number,
): void {
  const index = wiring.coordinator.resourceState.getIndex(resourceId);
  if (index === undefined) {
    console.error(
      `Warning: resource "${resourceId}" not found in ${content.metadata.id}.`,
    );
    return;
  }

  const current = wiring.coordinator.resourceState.getAmount(index);
  if (current >= amount) {
    return;
  }

  wiring.coordinator.resourceState.addAmount(index, amount - current);
}

function seedBaselineScenario(context: ScenarioContext): void {
  const { content, wiring } = context;

  ensureResourceFloor(content, wiring, 'sample-pack.energy', 50);
  wiring.coordinator.incrementGeneratorOwned('sample-pack.reactor', 1);
  wiring.coordinator.setGeneratorEnabled('sample-pack.reactor', true);
}

function seedProgressionScenario(context: ScenarioContext): void {
  const { content, wiring, stepSizeMs } = context;

  ensureResourceFloor(content, wiring, 'sample-pack.energy', 2_000);
  ensureResourceFloor(content, wiring, 'sample-pack.crystal', 500);
  ensureResourceFloor(content, wiring, 'sample-pack.alloy', 250);
  ensureResourceFloor(content, wiring, 'sample-pack.data-core', 100);
  ensureResourceFloor(content, wiring, 'sample-pack.prestige-flux', 25);

  for (const generator of content.generators) {
    wiring.coordinator.incrementGeneratorOwned(generator.id, 10);
    wiring.coordinator.setGeneratorEnabled(generator.id, true);
  }

  if (wiring.automationSystem) {
    const state = content.automations.map((automation) => ({
      id: automation.id,
      enabled: true,
      lastFiredStep: null,
      cooldownExpiresStep: 0,
      unlocked: true,
      lastThresholdSatisfied: false,
    }));
    wiring.automationSystem.restoreState(state, {
      savedWorkerStep: 0,
      currentStep: wiring.runtime.getCurrentStep(),
    });
  }

  const nextStep = wiring.runtime.getNextExecutableStep();
  for (const transform of content.transforms ?? []) {
    wiring.commandQueue.enqueue({
      type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
      payload: { transformId: transform.id },
      priority: CommandPriority.PLAYER,
      timestamp: nextStep * stepSizeMs,
      step: nextStep,
    });
  }
}

function computeStats(samples: number[]): BenchmarkStats {
  if (samples.length === 0) {
    return {
      meanMs: null,
      medianMs: null,
      stdDevMs: null,
      minMs: null,
      maxMs: null,
      hz: null,
      samples: 0,
      unit: 'ms',
    };
  }

  const total = samples.reduce((sum, value) => sum + value, 0);
  const mean = total / samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    samples.length;
  const stdDev = Math.sqrt(Math.max(variance, 0));
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const hz = mean > 0 ? 1000 / mean : null;

  return {
    meanMs: roundNumber(mean),
    medianMs: roundNumber(median),
    stdDevMs: roundNumber(stdDev),
    minMs: roundNumber(min),
    maxMs: roundNumber(max),
    hz: roundNumber(hz, 3),
    samples: samples.length,
    unit: 'ms',
  };
}

function roundNumber(value: number, decimals = 6): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function findGitEntry(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, '.git');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveGitDirectory(entryPath: string): string | null {
  try {
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      return entryPath;
    }
  } catch {
    return null;
  }

  try {
    const content = readFileSync(entryPath, 'utf8').trim();
    const prefix = 'gitdir:';
    if (!content.startsWith(prefix)) {
      return null;
    }
    const gitDirPath = content.slice(prefix.length).trim();
    if (!gitDirPath) {
      return null;
    }
    return path.isAbsolute(gitDirPath)
      ? gitDirPath
      : path.resolve(path.dirname(entryPath), gitDirPath);
  } catch {
    return null;
  }
}

function readGitTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function resolvePackedRefSha(gitDir: string, ref: string): string | null {
  const packedRefs = readGitTextFile(path.join(gitDir, 'packed-refs'));
  if (!packedRefs) {
    return null;
  }

  for (const line of packedRefs.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) {
      continue;
    }
    const [sha, refName] = line.split(' ');
    if (sha && refName === ref) {
      return sha;
    }
  }

  return null;
}

function resolveGitHeadSha(gitDir: string): string | null {
  const head = readGitTextFile(path.join(gitDir, 'HEAD'));
  if (!head) {
    return null;
  }

  const refPrefix = 'ref:';
  if (!head.startsWith(refPrefix)) {
    return isCommitSha(head) ? head : null;
  }

  const ref = head.slice(refPrefix.length).trim();
  if (!ref) {
    return null;
  }

  const refSha = readGitTextFile(path.join(gitDir, ref));
  if (refSha && isCommitSha(refSha)) {
    return refSha;
  }

  const packedSha = resolvePackedRefSha(gitDir, ref);
  return packedSha && isCommitSha(packedSha) ? packedSha : null;
}

function resolveCommitSha(): string | null {
  const envSha =
    process.env.GITHUB_SHA ??
    process.env.CI_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    process.env.BUILD_VCS_NUMBER;
  if (envSha) {
    return envSha;
  }

  const gitEntry = findGitEntry(process.cwd());
  if (!gitEntry) {
    return null;
  }

  const gitDir = resolveGitDirectory(gitEntry);
  if (!gitDir) {
    return null;
  }

  return resolveGitHeadSha(gitDir);
}

function getEnvMetadata() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    commitSha: resolveCommitSha(),
  };
}

function runLegacySim(args: CliArgs): void {
  assertPositiveInteger(args.ticks, '--ticks <n>');
  assertPositiveNumber(args.stepMs, '--step-ms <ms>');

  const maxSteps = args.maxStepsPerFrame ?? 50;
  assertPositiveInteger(maxSteps, '--max-steps-per-frame <n>');

  const timelineOptions: RuntimeDiagnosticsTimelineOptions = {
    enabled: true,
    // Use step size as the default slow-tick budget to flag overruns
    slowTickBudgetMs: args.slowTickBudgetMs ?? args.stepMs,
  };

  const runtime = new IdleEngineRuntime({
    stepSizeMs: args.stepMs,
    maxStepsPerFrame: maxSteps,
    diagnostics: { timeline: timelineOptions },
  });

  // Deterministically advance the runtime in fixed steps.
  for (let i = 0; i < (args.ticks ?? 0); i += 1) {
    runtime.tick(args.stepMs);
  }

  const result = runtime.getDiagnosticTimelineSnapshot();

  // Always emit JSON on stdout (single line)
  process.stdout.write(JSON.stringify(result) + '\n');

  // Evaluate thresholds for exit code
  const thresholds: DiagnosticsThresholds = {};
  if (args.failOnSlow && typeof result.configuration.tickBudgetMs === 'number') {
    thresholds.maxTickDurationMs = result.configuration.tickBudgetMs;
  }
  if (typeof args.queueBacklogCap === 'number' && Number.isFinite(args.queueBacklogCap)) {
    thresholds.maxQueueBacklog = args.queueBacklogCap;
  }

  if (Object.keys(thresholds).length > 0) {
    const evaluation = evaluateDiagnostics(result, thresholds);
	    if (!evaluation.ok) {
	      // Surface reasons to stderr so CI/users can understand failures while
	      // keeping stdout clean for JSON consumers.
	      const reasons = evaluation.reasons.join('; ');
      console.error(`Thresholds breached: ${reasons}`);
      const s = evaluation.summary;
      console.error(
        `Summary — ticks:${s.totalEntries} maxTick:${s.maxTickDurationMs.toFixed(2)}ms ` +
	          `avgTick:${s.avgTickDurationMs.toFixed(2)}ms maxQueueBacklog:${s.maxQueueBacklog}`,
	      );
	      process.exit(1);
	    }
	  }
}

function runScenario(
  scenario: ScenarioDefinition,
  args: CliArgs,
): { result: ScenarioResult; timeline: DiagnosticTimelineResult } {
  const stepSizeMs = args.stepMs;
  const warmupTicks = args.warmupTicks ?? DEFAULT_WARMUP_TICKS;
  const measureTicks = args.measureTicks ?? args.ticks ?? DEFAULT_MEASURE_TICKS;
  const seed = args.seed ?? scenario.seed;

  assertPositiveNumber(stepSizeMs, '--step-ms <ms>');
  assertNonNegativeInteger(warmupTicks, '--warmup-ticks <n>');
  assertPositiveInteger(measureTicks, '--measure-ticks <n>');

  resetRNG();
  setRNGSeed(seed);

  const wiring = createGameRuntime({
    content: sampleContent,
    stepSizeMs,
    ...(args.maxStepsPerFrame === undefined
      ? {}
      : { maxStepsPerFrame: args.maxStepsPerFrame }),
  });

  const capacity = Math.max(1, warmupTicks + measureTicks + 5);
  const timelineOptions: RuntimeDiagnosticsTimelineOptions = {
    enabled: true,
    slowTickBudgetMs: args.slowTickBudgetMs ?? stepSizeMs,
    capacity,
  };
  wiring.runtime.enableDiagnostics(timelineOptions);

  scenario.setup({ wiring, content: sampleContent, stepSizeMs });

  for (let i = 0; i < warmupTicks; i += 1) {
    wiring.runtime.tick(stepSizeMs);
  }

  const warmupHead = wiring.runtime.readDiagnosticsDelta().head;

  for (let i = 0; i < measureTicks; i += 1) {
    wiring.runtime.tick(stepSizeMs);
  }

  const timeline = wiring.runtime.readDiagnosticsDelta(warmupHead);
  const summary = summarizeDiagnostics(timeline);
  const stats = computeStats(timeline.entries.map((entry) => entry.durationMs));
  const snapshotBytes = Buffer.byteLength(JSON.stringify(timeline));
  const memory = args.includeMemory ? toMemorySummary(process.memoryUsage()) : undefined;

  return {
    result: {
      label: scenario.label,
      stepSizeMs,
      warmupTicks,
      measureTicks,
      stats,
      diagnostics: {
        slowTickCount: summary.slowTickCount,
        maxQueueBacklog: summary.maxQueueBacklog,
        maxTickDurationMs: summary.maxTickDurationMs,
        avgTickDurationMs: summary.avgTickDurationMs,
        dropped: summary.dropped,
      },
      snapshot: {
        bytes: snapshotBytes,
        entries: timeline.entries.length,
      },
      ...(memory ? { memory } : {}),
    },
    timeline,
  };
}

function toMemorySummary(memory: NodeJS.MemoryUsage): MemorySummary {
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function runScenarioHarness(args: CliArgs): void {
  const scenarios = resolveScenarios(args.scenarios);
  if (scenarios.length === 0) {
    console.error('Error: Scenario mode requires at least one scenario.');
    printHelpAndExit(2);
  }

  if (args.maxStepsPerFrame !== undefined) {
    assertPositiveInteger(args.maxStepsPerFrame, '--max-steps-per-frame <n>');
  }

  const results: ScenarioResult[] = [];
  const failures: { scenario: string; reasons: string[] }[] = [];

  for (const scenario of scenarios) {
    const { result, timeline } = runScenario(scenario, args);
    results.push(result);

    const thresholds: DiagnosticsThresholds = {};
    if (args.failOnSlow && typeof timeline.configuration.tickBudgetMs === 'number') {
      thresholds.maxTickDurationMs = timeline.configuration.tickBudgetMs;
    }
    if (typeof args.queueBacklogCap === 'number' && Number.isFinite(args.queueBacklogCap)) {
      thresholds.maxQueueBacklog = args.queueBacklogCap;
    }

    if (Object.keys(thresholds).length > 0) {
      const evaluation = evaluateDiagnostics(timeline, thresholds);
      if (!evaluation.ok) {
        failures.push({ scenario: result.label, reasons: [...evaluation.reasons] });
      }
    }
  }

  const payload = {
    event: BENCHMARK_EVENT,
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmark: { name: 'runtime-workload-sim' },
    config: {
      stepSizeMs: args.stepMs,
      warmupTicks: args.warmupTicks ?? DEFAULT_WARMUP_TICKS,
      measureTicks: args.measureTicks ?? args.ticks ?? DEFAULT_MEASURE_TICKS,
      seed: args.seed ?? DEFAULT_SEED,
      ...(args.maxStepsPerFrame === undefined
        ? {}
        : { maxStepsPerFrame: args.maxStepsPerFrame }),
      scenarios: scenarios.map((scenario) => scenario.id),
      includeMemory: args.includeMemory,
    },
    results: {
      scenarios: results,
    },
    env: getEnvMetadata(),
  };

  process.stdout.write(JSON.stringify(payload) + '\n');

	if (failures.length > 0) {
	  for (const failure of failures) {
	    console.error(
	      `Scenario "${failure.scenario}" breached thresholds: ${failure.reasons.join('; ')}`,
	    );
	  }
	  process.exit(1);
	}
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.helpRequested) {
    printHelpAndExit(0);
  }

	if (args.listScenarios) {
	  printScenarioList();
	  process.exit(0);
	}

  if (args.scenarios.length > 0) {
    runScenarioHarness(args);
    return;
  }

	runLegacySim(args);
}

main().catch((error) => {
	console.error('runtime-sim failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
