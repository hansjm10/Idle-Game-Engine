#!/usr/bin/env tsx
/*
 * Headless runtime simulator that advances the IdleEngineRuntime for N ticks
 * and prints the diagnostics timeline JSON to stdout. Exits non-zero when
 * configured thresholds are exceeded.
 */

import {
  IdleEngineRuntime,
  evaluateDiagnostics,
  type DiagnosticsThresholds,
  type RuntimeDiagnosticsTimelineOptions,
} from '@idle-engine/core';

interface CliArgs {
  ticks: number;
  stepMs: number;
  maxStepsPerFrame: number;
  failOnSlow: boolean;
  queueBacklogCap?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    ticks: 0,
    stepMs: 100,
    maxStepsPerFrame: 50,
    failOnSlow: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--ticks') {
      args.ticks = Number(argv[++i]);
    } else if (a === '--step-ms') {
      args.stepMs = Number(argv[++i]);
    } else if (a === '--max-steps-per-frame') {
      args.maxStepsPerFrame = Number(argv[++i]);
    } else if (a === '--fail-on-slow') {
      args.failOnSlow = true;
    } else if (a === '--queue-backlog-cap') {
      args.queueBacklogCap = Number(argv[++i]);
    } else if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    }
  }

  if (!Number.isFinite(args.ticks) || args.ticks <= 0) {
    console.error('Error: --ticks <n> must be a positive integer');
    printHelpAndExit(2);
  }
  if (!Number.isFinite(args.stepMs) || args.stepMs <= 0) {
    console.error('Error: --step-ms <ms> must be a positive number');
    printHelpAndExit(2);
  }
  if (!Number.isFinite(args.maxStepsPerFrame) || args.maxStepsPerFrame <= 0) {
    console.error('Error: --max-steps-per-frame <n> must be a positive integer');
    printHelpAndExit(2);
  }

  return args;
}

function printHelpAndExit(code: number): never {
  // Keep stdout clean for JSON consumers; print help on stderr.
  console.error(`Usage: pnpm core:tick-sim --ticks <n> [options]\n\n` +
    `Options:\n` +
    `  --ticks <n>                 Number of ticks to execute (required)\n` +
    `  --step-ms <ms>              Step size in milliseconds (default: 100)\n` +
    `  --max-steps-per-frame <n>   Clamp steps per frame (default: 50)\n` +
    `  --fail-on-slow              Exit non-zero when any tick exceeds budget\n` +
    `  --queue-backlog-cap <n>     Exit non-zero if queue backlog exceeds <n>\n`);
  // eslint-disable-next-line no-process-exit
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const timelineOptions: RuntimeDiagnosticsTimelineOptions = {
    enabled: true,
    // Use step size as the default slow-tick budget to flag overruns
    slowTickBudgetMs: args.stepMs,
  };

  const runtime = new IdleEngineRuntime({
    stepSizeMs: args.stepMs,
    maxStepsPerFrame: args.maxStepsPerFrame,
    diagnostics: { timeline: timelineOptions },
  });

  // Deterministically advance the runtime in fixed steps.
  for (let i = 0; i < args.ticks; i += 1) {
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
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    }
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await
main().catch((error) => {
  console.error('runtime-sim failed:', error instanceof Error ? error.message : String(error));
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
