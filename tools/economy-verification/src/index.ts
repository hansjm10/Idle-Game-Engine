#!/usr/bin/env tsx

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  createVerificationRuntime,
  runVerificationTicks,
} from '@idle-engine/core';
import type { EconomyStateSummary, ResourceDefinition } from '@idle-engine/core';
import { sampleContent } from '@idle-engine/content-sample';

// Telemetry is silent by default in @idle-engine/core, no configuration needed.

interface CliArgs {
  readonly snapshotPath?: string;
  readonly ticks?: number;
  readonly offlineMs?: number;
  readonly definitionsPath?: string;
  readonly includeDiagnostics: boolean;
  readonly helpRequested: boolean;
}

interface LoadedDefinitions {
  readonly definitions: readonly ResourceDefinition[];
  readonly source: string;
}

function printHelp(code: number): never {
  // Keep stdout clean for JSON consumers.
  console.error(
    `Usage: pnpm core:economy-verify --snapshot <file> --ticks <n> [options]\n\n` +
      `Options:\n` +
      `  --snapshot <file>        Path to EconomyStateSummary JSON (required)\n` +
      `  --ticks <n>              Number of ticks to simulate; derived from --offline-ms when omitted\n` +
      `  --offline-ms <ms>        Offline duration; converted to ticks using snapshot.stepSizeMs\n` +
      `  --definitions <file>     Resource definitions JSON; defaults to @idle-engine/content-sample\n` +
      `  --include-diagnostics    Include diagnostic timeline in output\n` +
      `  -h, --help               Show this help text`,
  );
  // eslint-disable-next-line no-process-exit
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    includeDiagnostics: false,
    helpRequested: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--snapshot') {
      index += 1;
      args.snapshotPath = argv[index];
      continue;
    }
    if (value === '--ticks') {
      index += 1;
      args.ticks = Number(argv[index]);
      continue;
    }
    if (value === '--offline-ms') {
      index += 1;
      args.offlineMs = Number(argv[index]);
      continue;
    }
    if (value === '--definitions') {
      index += 1;
      args.definitionsPath = argv[index];
      continue;
    }
    if (value === '--include-diagnostics') {
      args.includeDiagnostics = true;
      continue;
    }
    if (value === '--help' || value === '-h') {
      args.helpRequested = true;
      continue;
    }
  }

  return args;
}

async function loadSnapshot(snapshotPath: string): Promise<EconomyStateSummary> {
  const raw = await fs.readFile(snapshotPath, 'utf8');
  const snapshot = JSON.parse(raw) as Partial<EconomyStateSummary>;
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    !Array.isArray(snapshot.resources) ||
    typeof snapshot.step !== 'number' ||
    typeof snapshot.stepSizeMs !== 'number' ||
    typeof snapshot.definitionDigest !== 'object'
  ) {
    throw new Error('Snapshot must be an EconomyStateSummary JSON object.');
  }
  return snapshot as EconomyStateSummary;
}

function selectResourcesFromPayload(payload: any): ResourceDefinition[] | undefined {
  if (Array.isArray(payload)) {
    return payload as ResourceDefinition[];
  }
  if (payload?.modules?.resources && Array.isArray(payload.modules.resources)) {
    return payload.modules.resources as ResourceDefinition[];
  }
  if (payload?.resources && Array.isArray(payload.resources)) {
    return payload.resources as ResourceDefinition[];
  }
  return undefined;
}

async function loadDefinitions(
  definitionsPath?: string,
): Promise<LoadedDefinitions> {
  if (!definitionsPath) {
    const resources = sampleContent.modules.resources as ResourceDefinition[];
    return {
      definitions: resources,
      source: '@idle-engine/content-sample',
    };
  }

  const raw = await fs.readFile(definitionsPath, 'utf8');
  const parsed = JSON.parse(raw);
  const definitions = selectResourcesFromPayload(parsed);

  if (!definitions || definitions.length === 0) {
    throw new Error(
      'Definitions file must contain an array of resources (either top-level, resources[], or modules.resources[]).',
    );
  }

  return {
    definitions,
    source: path.resolve(definitionsPath),
  };
}

function toTicks(
  ticks: number | undefined,
  offlineMs: number | undefined,
  stepSizeMs: number,
): number {
  if (Number.isFinite(ticks)) {
    return Number(ticks);
  }
  if (Number.isFinite(offlineMs)) {
    const computed = Math.floor(Number(offlineMs) / stepSizeMs);
    return computed >= 0 ? computed : 0;
  }
  throw new Error('Either --ticks or --offline-ms must be provided.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.helpRequested) {
    printHelp(0);
  }

  if (!args.snapshotPath) {
    printHelp(2);
  }

  const snapshot = await loadSnapshot(args.snapshotPath);
  const ticks = toTicks(args.ticks, args.offlineMs, snapshot.stepSizeMs);
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new Error('--ticks must be a non-negative integer.');
  }

  const { definitions, source } = await loadDefinitions(args.definitionsPath);
  const verification = createVerificationRuntime({
    summary: snapshot,
    definitions,
  });

  const result = runVerificationTicks(verification, {
    ticks,
    includeDiagnostics: args.includeDiagnostics,
  });

  const report = {
    event: 'economy_verification',
    computedAt: Date.now(),
    snapshotPath: path.resolve(args.snapshotPath),
    definitionsSource: source,
    stepSizeMs: snapshot.stepSizeMs,
    ticks,
    offlineMs: ticks * snapshot.stepSizeMs,
    reconciliation: {
      digestsMatch: verification.reconciliation.digestsMatch,
      addedIds: verification.reconciliation.addedIds,
      removedIds: verification.reconciliation.removedIds,
    },
    result,
  };

  process.stdout.write(JSON.stringify(report) + '\n');
}

main().catch((error) => {
  console.error(
    'economy-verification failed:',
    error instanceof Error ? error.message : String(error),
  );
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
