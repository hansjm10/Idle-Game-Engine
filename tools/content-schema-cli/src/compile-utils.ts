import path from 'node:path';

import type { FileWriteOperation } from '@idle-engine/content-compiler';

// ============================================================================
// Types
// ============================================================================

export interface CliOptions {
  check: boolean;
  clean: boolean;
  pretty: boolean;
  watch: boolean;
  summary: string | undefined;
  cwd: string | undefined;
}

export interface WatchTrigger {
  event: string;
  path?: string;
}

export interface RunSummary {
  packTotals: {
    total: number;
    compiled: number;
    failed: number;
    withWarnings: number;
  };
  artifactActions: {
    total: number;
    changed: number;
    byAction: Record<string, number>;
  };
  changedPacks: string[];
  failedPacks: string[];
  hasChanges: boolean;
  summaryAction: string;
  manifestAction: string;
}

export interface PipelineOutcome {
  success: boolean;
  drift: boolean;
  runSummary: RunSummary | undefined;
}

export interface ParsedValueArg {
  value: string;
  skip: number;
}

export interface NormalizedError {
  name?: string;
  message: string;
  stack?: string;
}

export interface FormattedArtifact {
  kind: string;
  action: string;
  path: string;
}

export interface FormattedOperation {
  kind: string;
  path: string;
  action: string;
}

export interface WatchTriggerSummary {
  count: number;
  limit: number;
  events?: Record<string, number>;
  paths?: string[];
  morePaths?: number;
}

export interface ValidationFailureSummaryEntry {
  packSlug: string;
  packVersion?: string;
  path: string;
  message: string;
  issues?: unknown[];
}

export interface BalanceIssue {
  code?: string;
}

export interface PackBalanceCounts {
  balanceWarnings: number;
  balanceErrors: number;
}

export interface SpawnProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// ============================================================================
// Constants
// ============================================================================

export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--check',
  '--clean',
  '--pretty',
  '--watch',
]);

export const MAX_TRIGGER_PATHS = 10;

// ============================================================================
// Pure Helper Functions
// ============================================================================

export function parseValueArg(
  arg: string,
  argv: string[],
  index: number,
  flagName: string,
): ParsedValueArg {
  if (arg.startsWith(`${flagName}=`)) {
    return { value: arg.slice(flagName.length + 1), skip: 0 };
  }
  const nextValue = argv[index + 1];
  if (!nextValue) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return { value: nextValue, skip: 1 };
}

export function parseArgs(argv: string[], resolveCwd: (p: string) => string): CliOptions {
  const options: CliOptions = {
    check: false,
    clean: false,
    pretty: false,
    watch: false,
    summary: undefined,
    cwd: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (BOOLEAN_FLAGS.has(arg)) {
      const flagKey = arg.slice(2) as keyof Pick<
        CliOptions,
        'check' | 'clean' | 'pretty' | 'watch'
      >;
      options[flagKey] = true;
      continue;
    }

    if (arg === '--cwd' || arg === '-C' || arg.startsWith('--cwd=')) {
      const parsed = parseValueArg(arg, argv, index, '--cwd');
      options.cwd = resolveCwd(parsed.value);
      index += parsed.skip;
      continue;
    }

    if (arg === '--summary' || arg.startsWith('--summary=')) {
      const parsed = parseValueArg(arg, argv, index, '--summary');
      options.summary = parsed.value;
      index += parsed.skip;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      return { ...options, cwd: '__HELP__' };
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message ?? String(error),
      stack: error.stack,
    };
  }
  const message = String(error);
  return {
    name: undefined,
    message,
    stack: undefined,
  };
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function toPosixPath(inputPath: string): string {
  if (inputPath === '') {
    return '';
  }
  return inputPath.split(path.sep).join('/');
}

export function isChangeAction(action: string): boolean {
  return (
    action === 'written' ||
    action === 'deleted' ||
    action === 'would-write' ||
    action === 'would-delete'
  );
}

export function formatOperation(operation: FileWriteOperation): FormattedOperation {
  return {
    kind: operation.kind,
    path: operation.path,
    action: operation.action,
  };
}

export function extractRuntimeEventManifestHash(source: string): string | undefined {
  const match = /hash\s*:\s*['"]([0-9a-f]{8})['"]/i.exec(source);
  return typeof match?.[1] === 'string' ? match[1].toLowerCase() : undefined;
}

export function summarizeWatchTriggers(triggers: WatchTrigger[]): WatchTriggerSummary {
  const eventsByType: Record<string, number> = Object.create(null);
  const uniquePaths: string[] = [];
  const seenPaths = new Set<string>();

  for (const trigger of triggers) {
    const { event, path: triggerPath } = trigger ?? {};
    if (typeof event === 'string') {
      eventsByType[event] = (eventsByType[event] ?? 0) + 1;
    }
    if (typeof triggerPath === 'string' && !seenPaths.has(triggerPath)) {
      seenPaths.add(triggerPath);
      uniquePaths.push(triggerPath);
    }
  }

  const sortedEventEntries = Object.entries(eventsByType).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const limitedPaths = uniquePaths.slice(0, MAX_TRIGGER_PATHS);
  const overflow = uniquePaths.length - limitedPaths.length;

  const summary: WatchTriggerSummary = {
    count: triggers.length,
    limit: MAX_TRIGGER_PATHS,
    ...(sortedEventEntries.length > 0
      ? { events: Object.fromEntries(sortedEventEntries) }
      : {}),
    ...(limitedPaths.length > 0 ? { paths: limitedPaths } : {}),
  };

  if (overflow > 0) {
    summary.morePaths = overflow;
  }

  return summary;
}

export function deriveBalanceFromIssues(
  issues: BalanceIssue[] | undefined,
): { balance?: unknown } {
  if (!Array.isArray(issues)) {
    return {};
  }

  const balanceErrors = issues.filter(
    (issue) => typeof issue?.code === 'string' && issue.code.startsWith('balance.'),
  );

  if (balanceErrors.length === 0) {
    return {};
  }

  return {
    balance: {
      warnings: [],
      errors: balanceErrors,
      warningCount: 0,
      errorCount: balanceErrors.length,
    },
  };
}

export function emptySummaryDependencies(): {
  requires: never[];
  optional: never[];
  conflicts: never[];
} {
  return {
    requires: [],
    optional: [],
    conflicts: [],
  };
}

export function emptySummaryArtifacts(): Record<string, never> {
  return {};
}

export function createValidationFailureSummary(
  failures: readonly ValidationFailureSummaryEntry[],
): { packs: unknown[] } {
  const packs = failures
    .map((failure) => ({
      slug: failure.packSlug ?? failure.path,
      status: 'failed',
      ...(failure.packVersion ? { version: failure.packVersion } : {}),
      warnings: [],
      ...deriveBalanceFromIssues(failure.issues as BalanceIssue[] | undefined),
      dependencies: emptySummaryDependencies(),
      artifacts: emptySummaryArtifacts(),
      error: failure.message,
    }))
    .sort((left, right) => {
      if (left.slug === right.slug) {
        return 0;
      }
      return left.slug < right.slug ? -1 : 1;
    });

  return { packs };
}

export function createValidationFailureRunSummary({
  failures,
  summaryAction,
}: {
  failures: readonly ValidationFailureSummaryEntry[];
  summaryAction: string;
}): RunSummary {
  const failedSlugs = Array.from(
    new Set(
      failures
        .map((failure) => failure.packSlug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const actionChanges = summaryAction === 'written' || summaryAction === 'would-write';

  return {
    packTotals: {
      total: failedSlugs.length,
      compiled: 0,
      failed: failedSlugs.length,
      withWarnings: 0,
    },
    artifactActions: {
      total: 0,
      changed: 0,
      byAction: {},
    },
    changedPacks: [],
    failedPacks: failedSlugs,
    hasChanges: actionChanges,
    summaryAction,
    manifestAction: 'skipped',
  };
}

export function resolveSummaryOutputPath(
  rootDirectory: string,
  overridePath?: string,
): string {
  if (overridePath) {
    return path.isAbsolute(overridePath)
      ? overridePath
      : path.join(rootDirectory, overridePath);
  }
  return path.join(rootDirectory, 'content', 'compiled', 'index.json');
}

export function resolveWorkspaceRoot(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

export function normalizeWatchTargetPath(
  workspaceRoot: string,
  targetPath: string,
): string {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return '';
  }
  const absolutePath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(workspaceRoot, targetPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return toPosixPath(relativePath);
}

export function formatProcessOutput(result: SpawnProcessResult): string {
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (combined.length === 0) {
    return '';
  }

  const maxLength = 4000;
  const clipped =
    combined.length > maxLength
      ? combined.slice(combined.length - maxLength)
      : combined;

  return clipped.trim();
}

export function groupOperationsBySlug(
  operations: readonly FileWriteOperation[],
): Map<string, FileWriteOperation[]> {
  const operationsBySlug = new Map<string, FileWriteOperation[]>();
  for (const operation of operations) {
    const existing = operationsBySlug.get(operation.slug);
    if (existing) {
      existing.push(operation);
    } else {
      operationsBySlug.set(operation.slug, [operation]);
    }
  }
  return operationsBySlug;
}

export function filterPrunedArtifacts(artifacts: FormattedArtifact[]): FormattedArtifact[] {
  return artifacts.filter(
    (artifact) => artifact.action === 'deleted' || artifact.action === 'would-delete',
  );
}

export function determineWatchStatus(
  outcome: PipelineOutcome,
): 'success' | 'failed' | 'skipped' {
  if (!outcome.success) {
    return 'failed';
  }

  if (outcome.runSummary?.hasChanges === false) {
    return 'skipped';
  }

  return 'success';
}
