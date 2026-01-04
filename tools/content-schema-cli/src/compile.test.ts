import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { compileWorkspacePacks } from '@idle-engine/content-compiler';
import JSON5 from 'json5';
import { describe, expect, it } from 'vitest';

import {
  buildRuntimeEventManifest,
  validateContentPacks,
  writeRuntimeEventManifest,
} from './generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, './compile.ts');
const TSX_PATH = path.resolve(__dirname, '../../../node_modules/.bin/tsx');
const CLI_TEST_TIMEOUT_MS = Number(
  process.env.CLI_TEST_TIMEOUT_MS ?? (process.env.CI ? 60000 : 30000),
);

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ParsedEvent {
  event?: string;
  name?: string;
  slug?: string;
  packSlug?: string;
  packVersion?: string;
  path?: string;
  action?: string;
  check?: boolean;
  warnings?: unknown[];
  warningCount?: number;
  balanceWarnings?: number;
  balanceErrors?: number;
  artifacts?: Array<{ action: string; path?: string }> | { changed?: number; total?: number };
  message?: string;
  stack?: string;
  fatal?: boolean;
  success?: boolean;
  drift?: boolean;
  summary?: {
    packTotals?: {
      total?: number;
      compiled?: number;
      failed?: number;
      withWarnings?: number;
    };
    artifactActions?: {
      total?: number;
      changed?: number;
      byAction?: Record<string, number>;
    };
    changedPacks?: string[];
    failedPacks?: string[];
    hasChanges?: boolean;
    summaryAction?: string;
    manifestAction?: string;
  } | null;
  mode?: string;
  durationMs?: number;
  status?: string;
  iteration?: number;
  triggers?: {
    count?: number;
    limit?: number;
    events?: Record<string, number>;
    paths?: string[];
    morePaths?: number;
  };
  packs?: {
    total?: number;
    compiled?: number;
    failed?: number;
    withWarnings?: number;
    changed?: number;
  };
  changedPacks?: string[];
  failedPacks?: string[];
  reason?: string;
  [key: string]: unknown;
}

interface PackConfig {
  slug: string;
  format?: 'json' | 'json5';
  document?: ContentPackDocument;
  overrides?: Partial<ContentPackDocument>;
  eventTypes?: EventManifest | false;
  json5Source?: string;
}

interface ContentPackDocument {
  metadata: {
    id: string;
    title: { default: string; variants: Record<string, unknown> };
    version: string;
    engine: string;
    defaultLocale: string;
    supportedLocales: string[];
    dependencies?: {
      requires?: Array<{ packId: string; version?: string }>;
    };
  };
  resources: unknown[];
  generators: unknown[];
  upgrades: unknown[];
  metrics: unknown[];
  achievements: unknown[];
  automations: unknown[];
  transforms: unknown[];
  prestigeLayers: unknown[];
  runtimeEvents: unknown[];
}

interface EventManifest {
  packSlug: string;
  eventTypes: Array<{
    namespace: string;
    name: string;
    version: number;
    schema: string;
  }>;
}

interface Workspace {
  root: string;
  cleanup: () => Promise<void>;
}

interface PackFile {
  path: string;
  format: 'json' | 'json5';
  document: ContentPackDocument;
}

interface EventCollector {
  push: (event: ParsedEvent) => void;
  waitForEvent: (matcher: (event: ParsedEvent) => boolean, timeoutMs?: number) => Promise<ParsedEvent>;
  history: () => ParsedEvent[];
}

interface WatchProcess {
  child: ChildProcess;
  events: EventCollector;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
}

describe('content schema CLI compile command', () => {
  it('compiles packs and emits structured events', async () => {
    const workspace = await createWorkspace([
      { slug: 'alpha-pack' },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const manifestEvent = events.find(
        (entry) => entry.event === 'runtime_manifest.written',
      );
      expect(manifestEvent?.action).toBe('written');

      const validationEvent = events.find(
        (entry) =>
          entry.event === 'content_pack.validated' &&
          entry.packSlug === 'alpha-pack',
      );
      expect(validationEvent?.warningCount).toBe(0);

      const compileEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.compiled' && entry.slug === 'alpha-pack',
      );
      expect(compileEvent).toBeDefined();
      expect(compileEvent?.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'written',
            path: expect.stringContaining(
              'packages/alpha-pack/content/compiled/alpha-pack.normalized.json',
            ),
          }),
          expect.objectContaining({
            action: 'written',
            path: expect.stringContaining(
              'packages/alpha-pack/src/generated/alpha-pack.generated.ts',
            ),
          }),
        ]),
      );

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent).toBeDefined();
      expect(summaryEvent?.success).toBe(true);
      expect(summaryEvent?.drift).toBe(false);
      expect(summaryEvent?.summary?.packTotals?.compiled).toBe(1);
      expect(summaryEvent?.mode).toBe('single');

      await assertFileExists(
        path.join(
          workspace.root,
          'packages/core/src/events/runtime-event-manifest.generated.ts',
        ),
      );
      await assertFileExists(
        path.join(
          workspace.root,
          'packages/alpha-pack/content/compiled/alpha-pack.normalized.json',
        ),
      );
      await assertFileExists(
        path.join(
          workspace.root,
          'packages/alpha-pack/src/generated/alpha-pack.generated.ts',
        ),
      );
      await assertFileExists(
        path.join(workspace.root, 'content/compiled/index.json'),
      );

      const summaryRaw = await fs.readFile(
        path.join(workspace.root, 'content/compiled/index.json'),
        'utf8',
      );
      const summary = JSON.parse(summaryRaw) as { packs: Array<{ slug: string; balance?: { warningCount?: number; errorCount?: number } }> };
      const summaryEntry = summary.packs.find(
        (entry) => entry.slug === 'alpha-pack',
      );
      expect(summaryEntry?.balance?.warningCount).toBe(0);
      expect(summaryEntry?.balance?.errorCount).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('supports packs authored in JSON5', async () => {
    const workspace = await createWorkspace([
      { slug: 'json5-pack', format: 'json5' },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const validationEvent = events.find(
        (entry) =>
          entry.event === 'content_pack.validated' &&
          entry.packSlug === 'json5-pack',
      );
      expect(validationEvent).toBeDefined();
      expect(validationEvent?.packVersion).toBe('0.0.1');
      expect(validationEvent?.path).toContain('content/pack.json5');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it(
    'emits structured cli.unhandled_error events when manifest generation fails',
    async () => {
    const workspace = await createWorkspace([{ slug: 'error-pack' }]);
    const metadataPath = path.join(
      workspace.root,
      'packages/core/src/events/runtime-event-base-metadata.json',
    );
    await fs.writeFile(metadataPath, '{ not: "valid json"', 'utf8');

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(1);

      const events = parseEvents(result.stdout, result.stderr);
      const errorEvents = events.filter(
        (event) => event.event === 'cli.unhandled_error',
      );
      expect(errorEvents).toHaveLength(1);
      const [errorEvent] = errorEvents;
      expect(errorEvent?.fatal).toBe(true);
      expect(typeof errorEvent?.message).toBe('string');
      expect(typeof errorEvent?.stack).toBe('string');
      expect(errorEvent?.stack).toMatch(/SyntaxError/);

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent).toBeDefined();
      expect(summaryEvent?.success).toBe(false);
      expect(summaryEvent?.summary).toBeNull();

      const stderrLines = result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(stderrLines).not.toHaveLength(0);
      for (const line of stderrLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('writes a failure summary when validation fails', async () => {
    const workspace = await createWorkspace([
      {
        slug: 'invalid-pack',
        overrides: {
          resources: null as unknown as unknown[],
        },
      },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(1);

      const events = parseEvents(result.stdout, result.stderr);
      const failureEvent = events.find(
        (entry) =>
          entry.event === 'content_pack.validation_failed' &&
          entry.packSlug === 'invalid-pack',
      );
      expect(failureEvent).toBeDefined();
      expect(failureEvent?.path).toContain('packages/invalid-pack/content/pack.json');
      expect(events.some((entry) => entry.name === 'content_pack.compiled')).toBe(false);
      expect(events.some((entry) => entry.event?.startsWith?.('runtime_manifest.'))).toBe(false);
      expect(events.some((entry) => entry.event === 'cli.unhandled_error')).toBe(false);

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent).toBeDefined();
      expect(summaryEvent?.success).toBe(false);
      expect(summaryEvent?.drift).toBe(false);
      expect(summaryEvent?.summary?.packTotals?.failed).toBeGreaterThan(0);

      const summaryPath = path.join(workspace.root, 'content/compiled/index.json');
      const summaryRaw = await fs.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(summaryRaw) as { packs: Array<{ slug: string; status?: string; error?: string }> };
      const summaryEntry = summary.packs.find(
        (pack) => pack.slug === 'invalid-pack',
      );
      expect(summaryEntry?.status).toBe('failed');
      expect(typeof summaryEntry?.error).toBe('string');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('writes a failure summary in check mode', async () => {
    const workspace = await createWorkspace([
      {
        slug: 'invalid-pack',
        overrides: {
          resources: null as unknown as unknown[],
        },
      },
    ]);

    try {
      const result = await runCli(
        ['--cwd', workspace.root, '--check'],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(1);

      const events = parseEvents(result.stdout, result.stderr);
      const failureEvent = events.find(
        (entry) =>
          entry.event === 'content_pack.validation_failed' &&
          entry.packSlug === 'invalid-pack',
      );
      expect(failureEvent).toBeDefined();
      expect(events.some((entry) => entry.name === 'content_pack.compiled')).toBe(
        false,
      );

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent).toBeDefined();
      expect(summaryEvent?.success).toBe(false);
      expect(summaryEvent?.drift).toBe(true);
      expect(summaryEvent?.summary?.packTotals?.failed).toBeGreaterThan(0);

      const summaryPath = path.join(
        workspace.root,
        'content/compiled/index.json',
      );
      const summaryRaw = await fs.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(summaryRaw) as { packs: Array<{ slug: string; status?: string; error?: string }> };
      const summaryEntry = summary.packs.find(
        (pack) => pack.slug === 'invalid-pack',
      );
      expect(summaryEntry?.status).toBe('failed');
      expect(typeof summaryEntry?.error).toBe('string');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('reports drift in check mode', async () => {
    const workspace = await createWorkspace([
      { slug: 'beta-pack' },
    ]);

    try {
      await seedWorkspaceOutputs(workspace.root);

      await bumpPackVersion(workspace.root, 'beta-pack', '0.0.2');

      const checkResult = await runCli(
        ['--cwd', workspace.root, '--check'],
        { cwd: workspace.root },
      );
      expect(checkResult.code).toBe(1);

      const events = parseEvents(checkResult.stdout, checkResult.stderr);
      const manifestEvent = events.find(
        (entry) => entry.event === 'runtime_manifest.unchanged',
      );
      expect(manifestEvent?.action).toBe('unchanged');

      const compileEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.compiled' && entry.slug === 'beta-pack',
      );
      expect(compileEvent?.check).toBe(true);
      const compileArtifacts = compileEvent?.artifacts as Array<{ action: string }> | undefined;
      expect(
        compileArtifacts?.some((artifact) => artifact.action === 'would-write'),
      ).toBe(true);

      const skippedEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.skipped' && entry.slug === 'beta-pack',
      );
      expect(skippedEvent).toBeUndefined();

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent).toBeDefined();
      expect(summaryEvent?.success).toBe(false);
      expect(summaryEvent?.drift).toBe(true);
      expect(
        summaryEvent?.summary?.artifactActions?.byAction?.['would-write'] ?? 0,
      ).toBeGreaterThan(0);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('does not treat a missing @idle-engine/core dist runtime event manifest as drift in check mode', async () => {
    const workspace = await createWorkspace([
      { slug: 'core-dist-pack' },
    ]);

    try {
      await seedWorkspaceOutputs(workspace.root);

      await writeJson(
        path.join(workspace.root, 'packages/core/package.json'),
        { name: '@idle-engine/core' },
      );

      const checkResult = await runCli(
        ['--cwd', workspace.root, '--check'],
        { cwd: workspace.root },
      );
      expect(checkResult.code).toBe(0);

      const events = parseEvents(checkResult.stdout, checkResult.stderr);
      const coreDistSkipEvent = events.find(
        (entry) => entry.event === 'runtime_manifest.core_dist.skipped',
      );
      expect(coreDistSkipEvent).toBeDefined();
      expect(coreDistSkipEvent?.reason).toBe('missing core dist runtime event manifest');

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent?.success).toBe(true);
      expect(summaryEvent?.drift).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('treats a stale @idle-engine/core dist runtime event manifest as drift in check mode', async () => {
    const workspace = await createWorkspace([
      { slug: 'core-dist-pack' },
    ]);

    try {
      await writeJson(
        path.join(workspace.root, 'packages/core/package.json'),
        { name: '@idle-engine/core' },
      );

      const manifest = await buildRuntimeEventManifest({
        rootDirectory: workspace.root,
      });

      await fs.mkdir(
        path.join(workspace.root, 'packages/core/dist/events'),
        { recursive: true },
      );
      await fs.writeFile(
        path.join(
          workspace.root,
          'packages/core/dist/events/runtime-event-manifest.generated.js',
        ),
        `export const GENERATED_RUNTIME_EVENT_MANIFEST = { hash: '${manifest.manifestHash}' };\n`,
        'utf8',
      );

      await seedWorkspaceOutputs(workspace.root);

      await fs.writeFile(
        path.join(
          workspace.root,
          'packages/core/dist/events/runtime-event-manifest.generated.js',
        ),
        `export const GENERATED_RUNTIME_EVENT_MANIFEST = { hash: 'deadbeef' };\n`,
        'utf8',
      );

      const checkResult = await runCli(
        ['--cwd', workspace.root, '--check'],
        { cwd: workspace.root },
      );
      expect(checkResult.code).toBe(1);

      const events = parseEvents(checkResult.stdout, checkResult.stderr);
      const coreDistDriftEvent = events.find(
        (entry) => entry.event === 'runtime_manifest.core_dist.drift',
      );
      expect(coreDistDriftEvent?.action).toBe('would-build');

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent?.success).toBe(false);
      expect(summaryEvent?.drift).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('emits failure events for missing dependencies', async () => {
    const workspace = await createWorkspace([
      {
        slug: 'delta-pack',
        overrides: {
          metadata: {
            dependencies: {
              requires: [{ packId: 'missing-pack' }],
            },
          },
        } as Partial<ContentPackDocument>,
      },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(1);

      const events = parseEvents(result.stdout, result.stderr);
      const failureEvents = events.filter(
        (entry) => entry.name === 'content_pack.compilation_failed',
      );
      expect(failureEvents).toHaveLength(1);
      const [failureEvent] = failureEvents;
      expect(failureEvent?.message).toMatch(/missing-pack/);
      expect(Array.isArray(failureEvent?.artifacts)).toBe(true);
      expect(failureEvent?.check).toBe(false);

      const warningEvent = events.find(
        (entry) => entry.event === 'content_pack.validated' && entry.packSlug === 'delta-pack',
      );
      expect(warningEvent?.warningCount).toBe(1);

      const summaryEvent = events.find(
        (entry) => entry.event === 'cli.run_summary',
      );
      expect(summaryEvent).toBeDefined();
      expect(summaryEvent?.success).toBe(false);
      expect(summaryEvent?.summary?.failedPacks).toEqual(
        expect.arrayContaining(['delta-pack']),
      );
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('rejects --watch combined with --check', async () => {
    const workspace = await createWorkspace([{ slug: 'test-pack' }]);

    try {
      const result = await runCli(
        ['--cwd', workspace.root, '--watch', '--check'],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--watch cannot be combined with --check');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('supports -C as shorthand for --cwd', async () => {
    const workspace = await createWorkspace([{ slug: 'shorthand-pack' }]);

    try {
      const result = await runCli(['-C', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const compileEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.compiled' && entry.slug === 'shorthand-pack',
      );
      expect(compileEvent).toBeDefined();
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('rejects unknown CLI options', async () => {
    const workspace = await createWorkspace([{ slug: 'test-pack' }]);

    try {
      const result = await runCli(
        ['--cwd', workspace.root, '--unknown-flag'],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown option: --unknown-flag');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('forces rewrites in --clean mode even when artifacts are unchanged', async () => {
    const workspace = await createWorkspace([{ slug: 'clean-pack' }]);

    try {
      const firstRun = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(firstRun.code).toBe(0);

      const firstEvents = parseEvents(firstRun.stdout, firstRun.stderr);
      const firstCompile = firstEvents.find(
        (entry) => entry.name === 'content_pack.compiled' && entry.slug === 'clean-pack',
      );
      expect(firstCompile).toBeDefined();
      const firstArtifacts = firstCompile?.artifacts as Array<{ action: string }> | undefined;
      expect(firstArtifacts?.some((a) => a.action === 'written')).toBe(true);

      const secondRun = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(secondRun.code).toBe(0);

      const secondEvents = parseEvents(secondRun.stdout, secondRun.stderr);
      const secondCompile = secondEvents.find(
        (entry) => entry.name === 'content_pack.compiled' && entry.slug === 'clean-pack',
      );
      const secondArtifacts = secondCompile?.artifacts as Array<{ action: string }> | undefined;
      expect(secondArtifacts?.every((a) => a.action === 'unchanged')).toBe(true);

      const cleanRun = await runCli(['--cwd', workspace.root, '--clean'], { cwd: workspace.root });
      expect(cleanRun.code).toBe(0);

      const cleanEvents = parseEvents(cleanRun.stdout, cleanRun.stderr);
      const cleanCompile = cleanEvents.find(
        (entry) => entry.name === 'content_pack.compiled' && entry.slug === 'clean-pack',
      );
      const cleanArtifacts = cleanCompile?.artifacts as Array<{ action: string }> | undefined;
      expect(cleanArtifacts?.some((a) => a.action === 'written')).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('outputs pretty-printed JSON with --pretty flag', async () => {
    const workspace = await createWorkspace([{ slug: 'pretty-pack' }]);

    try {
      const result = await runCli(['--cwd', workspace.root, '--pretty'], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const outputLines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const hasMultilineJson = outputLines.some((line) => {
        return line.trim().startsWith('{') && !line.trim().endsWith('}');
      });
      expect(hasMultilineJson).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('writes summary to custom path via --summary flag', async () => {
    const workspace = await createWorkspace([{ slug: 'summary-pack' }]);
    const customSummaryPath = path.join(workspace.root, 'custom-output', 'summary.json');

    try {
      const result = await runCli(
        ['--cwd', workspace.root, '--summary', customSummaryPath],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(0);

      await assertFileExists(customSummaryPath);
      const summaryRaw = await fs.readFile(customSummaryPath, 'utf8');
      const summary = JSON.parse(summaryRaw) as { packs: Array<{ slug: string }> };
      expect(summary.packs.some((p) => p.slug === 'summary-pack')).toBe(true);

      const defaultSummaryPath = path.join(workspace.root, 'content/compiled/index.json');
      const defaultExists = await pathExists(defaultSummaryPath);
      expect(defaultExists).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('compiles multiple packs and reports aggregated summary', async () => {
    const workspace = await createWorkspace([
      { slug: 'pack-one' },
      { slug: 'pack-two' },
      { slug: 'pack-three' },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const compiledPacks = events.filter((entry) => entry.name === 'content_pack.compiled');
      expect(compiledPacks).toHaveLength(3);

      const summaryEvent = events.find((entry) => entry.event === 'cli.run_summary');
      expect(summaryEvent?.summary?.packTotals?.total).toBe(3);
      expect(summaryEvent?.summary?.packTotals?.compiled).toBe(3);
      expect(summaryEvent?.summary?.packTotals?.failed).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('emits content_pack.skipped event when all artifacts are unchanged in check mode', async () => {
    const workspace = await createWorkspace([{ slug: 'skipped-pack' }]);

    try {
      await seedWorkspaceOutputs(workspace.root);

      const checkResult = await runCli(
        ['--cwd', workspace.root, '--check'],
        { cwd: workspace.root },
      );
      expect(checkResult.code).toBe(0);

      const events = parseEvents(checkResult.stdout, checkResult.stderr);
      const skippedEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.skipped' && entry.slug === 'skipped-pack',
      );
      expect(skippedEvent).toBeDefined();
      expect(skippedEvent?.check).toBe(true);

      const compiledEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.compiled' && entry.slug === 'skipped-pack',
      );
      expect(compiledEvent).toBeUndefined();
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('supports --summary=value inline syntax', async () => {
    const workspace = await createWorkspace([{ slug: 'inline-pack' }]);
    const customSummaryPath = path.join(workspace.root, 'inline-output', 'summary.json');

    try {
      const result = await runCli(
        ['--cwd', workspace.root, `--summary=${customSummaryPath}`],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(0);

      await assertFileExists(customSummaryPath);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('supports --cwd=value inline syntax', async () => {
    const workspace = await createWorkspace([{ slug: 'inline-cwd-pack' }]);

    try {
      const result = await runCli(
        [`--cwd=${workspace.root}`],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const compileEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.compiled' && entry.slug === 'inline-cwd-pack',
      );
      expect(compileEvent).toBeDefined();
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('handles mixed success and failure packs in same run', async () => {
    const workspace = await createWorkspace([
      { slug: 'valid-pack' },
      {
        slug: 'invalid-pack',
        overrides: {
          metadata: {
            dependencies: {
              requires: [{ packId: 'nonexistent-dep' }],
            },
          },
        } as Partial<ContentPackDocument>,
      },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(1);

      const events = parseEvents(result.stdout, result.stderr);
      const validatedEvents = events.filter(
        (entry) => entry.event === 'content_pack.validated',
      );
      expect(validatedEvents).toHaveLength(2);

      const compiledEvent = events.find(
        (entry) => entry.name === 'content_pack.compiled' && entry.slug === 'valid-pack',
      );
      expect(compiledEvent).toBeDefined();

      const failedEvent = events.find(
        (entry) => entry.name === 'content_pack.compilation_failed' && entry.slug === 'invalid-pack',
      );
      expect(failedEvent).toBeDefined();

      const summaryEvent = events.find((entry) => entry.event === 'cli.run_summary');
      expect(summaryEvent?.summary?.packTotals?.compiled).toBe(1);
      expect(summaryEvent?.summary?.packTotals?.failed).toBe(1);
      expect(summaryEvent?.summary?.failedPacks).toEqual(['invalid-pack']);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('resolves relative summary path correctly', async () => {
    const workspace = await createWorkspace([{ slug: 'relative-summary-pack' }]);
    const relativePath = 'custom-dir/my-summary.json';
    const absolutePath = path.join(workspace.root, relativePath);

    try {
      const result = await runCli(
        ['--cwd', workspace.root, '--summary', relativePath],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(0);

      await assertFileExists(absolutePath);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('reports error when --summary flag is missing value', async () => {
    const workspace = await createWorkspace([{ slug: 'missing-value-pack' }]);

    try {
      const result = await runCli(
        ['--cwd', workspace.root, '--summary'],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing value for --summary');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('reports error when --cwd flag is missing value', async () => {
    const workspace = await createWorkspace([{ slug: 'missing-cwd-pack' }]);

    try {
      const result = await runCli(
        ['--cwd'],
        { cwd: workspace.root },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Missing value for --cwd');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('includes duration in run summary', async () => {
    const workspace = await createWorkspace([{ slug: 'duration-pack' }]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const summaryEvent = events.find((entry) => entry.event === 'cli.run_summary');
      expect(summaryEvent).toBeDefined();
      expect(typeof summaryEvent?.durationMs).toBe('number');
      expect((summaryEvent?.durationMs as number) > 0).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('reports sorted failed packs in summary', async () => {
    const workspace = await createWorkspace([
      {
        slug: 'zebra-pack',
        overrides: {
          metadata: {
            dependencies: { requires: [{ packId: 'missing' }] },
          },
        } as Partial<ContentPackDocument>,
      },
      {
        slug: 'alpha-fail-pack',
        overrides: {
          metadata: {
            dependencies: { requires: [{ packId: 'missing' }] },
          },
        } as Partial<ContentPackDocument>,
      },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(1);

      const events = parseEvents(result.stdout, result.stderr);
      const summaryEvent = events.find((entry) => entry.event === 'cli.run_summary');
      expect(summaryEvent?.summary?.failedPacks).toEqual([
        'alpha-fail-pack',
        'zebra-pack',
      ]);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('tracks changed packs in summary', async () => {
    const workspace = await createWorkspace([
      { slug: 'changed-pack-one' },
      { slug: 'changed-pack-two' },
    ]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const summaryEvent = events.find((entry) => entry.event === 'cli.run_summary');
      expect(summaryEvent?.summary?.changedPacks).toEqual(
        expect.arrayContaining(['changed-pack-one', 'changed-pack-two']),
      );
      expect(summaryEvent?.summary?.hasChanges).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('reports artifact action counts by type in summary', async () => {
    const workspace = await createWorkspace([{ slug: 'action-count-pack' }]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const summaryEvent = events.find((entry) => entry.event === 'cli.run_summary');
      expect(summaryEvent?.summary?.artifactActions?.byAction).toBeDefined();
      expect(summaryEvent?.summary?.artifactActions?.byAction?.written).toBeGreaterThan(0);
      expect(summaryEvent?.summary?.artifactActions?.total).toBeGreaterThan(0);
      expect(summaryEvent?.summary?.artifactActions?.changed).toBeGreaterThan(0);
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('skips core dist manifest when core package.json is missing', async () => {
    const workspace = await createWorkspace([{ slug: 'no-core-pack' }]);
    const corePackageJsonPath = path.join(workspace.root, 'packages/core/package.json');

    try {
      if (await pathExists(corePackageJsonPath)) {
        await fs.rm(corePackageJsonPath);
      }

      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const coreDistEvent = events.find(
        (entry) => entry.event === 'runtime_manifest.core_dist.skipped',
      );
      expect(coreDistEvent).toBeDefined();
      expect(coreDistEvent?.reason).toBe('missing core package.json');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('includes balance counts in compiled pack events', async () => {
    const workspace = await createWorkspace([{ slug: 'balance-pack' }]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const compileEvent = events.find(
        (entry) => entry.name === 'content_pack.compiled' && entry.slug === 'balance-pack',
      );
      expect(compileEvent).toBeDefined();
      expect(typeof compileEvent?.balanceWarnings).toBe('number');
      expect(typeof compileEvent?.balanceErrors).toBe('number');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('reports manifest action in summary', async () => {
    const workspace = await createWorkspace([{ slug: 'manifest-action-pack' }]);

    try {
      const result = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(result.code).toBe(0);

      const events = parseEvents(result.stdout, result.stderr);
      const summaryEvent = events.find((entry) => entry.event === 'cli.run_summary');
      expect(summaryEvent?.summary?.manifestAction).toBe('written');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('reports unchanged manifest action on subsequent runs', async () => {
    const workspace = await createWorkspace([{ slug: 'unchanged-manifest-pack' }]);

    try {
      await runCli(['--cwd', workspace.root], { cwd: workspace.root });

      const secondResult = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(secondResult.code).toBe(0);

      const events = parseEvents(secondResult.stdout, secondResult.stderr);
      const manifestEvent = events.find(
        (entry) => entry.event === 'runtime_manifest.unchanged',
      );
      expect(manifestEvent).toBeDefined();
      expect(manifestEvent?.action).toBe('unchanged');
    } finally {
      await workspace.cleanup();
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('emits watch run events for changes, skips, and repeated failures with aggregated triggers', async () => {
    const packSlug = 'watch-pack';
    const workspace = await createWorkspace([{ slug: packSlug }]);
    const watchEventTimeoutMs = 20_000;
    const packPath = path.join(
      workspace.root,
      'packages',
      packSlug,
      'content/pack.json',
    );
    const contentDir = path.dirname(packPath);
    const bonusPath = path.join(contentDir, 'bonus.json');
    const packRelativePath = ['packages', packSlug, 'content', 'pack.json'].join('/');
    const bonusRelativePath = ['packages', packSlug, 'content', 'bonus.json'].join('/');

    const watchProcess = startWatchCli(
      ['--cwd', workspace.root, '--watch'],
      { cwd: workspace.root },
    );

    try {
      await watchProcess.events.waitForEvent(
        (event) => event.event === 'watch.status',
        watchEventTimeoutMs,
      );
      await watchProcess.events.waitForEvent(
        (event) => event.event === 'watch.hint',
        watchEventTimeoutMs,
      );
      await watchProcess.events.waitForEvent(
        (event) =>
          event.name === 'content_pack.compiled' && event.slug === packSlug,
        watchEventTimeoutMs,
      );

      await sleep(200);
      await Promise.all([
        bumpPackVersion(workspace.root, packSlug, '0.0.2'),
        writeJson(bonusPath, { generated: true }),
      ]);

      const successRun = await watchProcess.events.waitForEvent(
        (event) =>
          event.event === 'watch.run' && event.status === 'success',
        watchEventTimeoutMs,
      );
      expect(successRun.changedPacks).toEqual(
        expect.arrayContaining([packSlug]),
      );
      const successArtifacts = successRun.artifacts as { changed?: number } | undefined;
      expect(successArtifacts?.changed ?? 0).toBeGreaterThan(0);
      expect(successRun.triggers?.count ?? 0).toBeGreaterThan(1);
      expect(successRun.triggers?.events?.change ?? 0).toBeGreaterThanOrEqual(1);
      expect(successRun.triggers?.events?.add ?? 0).toBeGreaterThanOrEqual(1);
      expect(successRun.triggers?.paths ?? []).toEqual(
        expect.arrayContaining([packRelativePath, bonusRelativePath]),
      );

      await sleep(200);
      await rewritePackWithoutChanges(packPath);

      const skippedRun = await watchProcess.events.waitForEvent(
        (event) =>
          event.event === 'watch.run' && event.status === 'skipped',
        watchEventTimeoutMs,
      );
      const skippedArtifacts = skippedRun.artifacts as { changed?: number } | undefined;
      expect(skippedArtifacts?.changed ?? 0).toBe(0);
      expect(skippedRun.triggers?.count ?? 0).toBeGreaterThan(0);

      await sleep(200);
      await setMissingDependency(workspace.root, packSlug, 'missing-pack');

      await watchProcess.events.waitForEvent(
        (event) =>
          event.name === 'content_pack.compilation_failed' &&
          event.slug === packSlug,
        watchEventTimeoutMs,
      );

      const failureRun = await watchProcess.events.waitForEvent(
        (event) =>
          event.event === 'watch.run' && event.status === 'failed',
        watchEventTimeoutMs,
      );
      expect(failureRun.failedPacks).toEqual(
        expect.arrayContaining([packSlug]),
      );
      expect(failureRun.triggers?.count ?? 0).toBeGreaterThan(0);
      expect(failureRun.triggers?.paths ?? []).toEqual(
        expect.arrayContaining([packRelativePath]),
      );
      const failureIteration = failureRun.iteration ?? 0;

      await sleep(200);
      await rewritePackWithoutChanges(packPath);

      const repeatedFailureRun = await watchProcess.events.waitForEvent(
        (event) =>
          event.event === 'watch.run' &&
          event.status === 'failed' &&
          typeof event.iteration === 'number' &&
          event.iteration > failureIteration,
        watchEventTimeoutMs,
      );
      expect(repeatedFailureRun.failedPacks).toEqual(
        expect.arrayContaining([packSlug]),
      );
      expect(repeatedFailureRun.iteration).toBeGreaterThan(failureIteration);
      expect(repeatedFailureRun.triggers?.paths ?? []).toEqual(
        expect.arrayContaining([packRelativePath]),
      );
    } catch (error) {
      const history = watchProcess.events.history();
      const augmented = new Error(
        [
          error instanceof Error ? error.message : String(error),
          `History: ${JSON.stringify(history, null, 2)}`,
        ].join('\n\n'),
      );
      augmented.stack = error instanceof Error ? error.stack : augmented.stack;
      throw augmented;
    } finally {
      await watchProcess.stop();
      await workspace.cleanup();
    }
  }, 40000);
});

function createPackDocument(id: string, overrides: Partial<ContentPackDocument> = {}): ContentPackDocument {
  const baseDocument: ContentPackDocument = {
    metadata: {
      id,
      title: { default: `${id} title`, variants: {} },
      version: '0.0.1',
      engine: '^0.1.0',
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
    },
    resources: [],
    generators: [],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    runtimeEvents: [],
  };

  return {
    ...baseDocument,
    ...overrides,
    metadata: {
      ...baseDocument.metadata,
      ...(overrides.metadata ?? {}),
      id,
    },
  };
}

function createDefaultEventTypes(slug: string): EventManifest {
  return {
    packSlug: slug,
    eventTypes: [
      {
        namespace: slug,
        name: 'ping',
        version: 1,
        schema: './schemas/ping.schema.json',
      },
    ],
  };
}

async function createWorkspace(packs: PackConfig[]): Promise<Workspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'content-cli-'));

  await writeJson(
    path.join(
      root,
      'packages/core/src/events/runtime-event-base-metadata.json',
    ),
    [],
  );

  for (const packConfig of packs) {
    const slug = packConfig.slug;
    const document = packConfig.document ?? createPackDocument(slug, packConfig.overrides);
    const packageRoot = path.join(root, 'packages', slug);
    const packFormat = packConfig.format === 'json5' ? 'json5' : 'json';
    const packFilename = packFormat === 'json5' ? 'pack.json5' : 'pack.json';

    const packPath = path.join(packageRoot, 'content', packFilename);
    if (packFormat === 'json5') {
      const json5Source =
        typeof packConfig.json5Source === 'string'
          ? packConfig.json5Source
          : undefined;
      await writeJson5(packPath, json5Source ?? document);
    } else {
      await writeJson(packPath, document);
    }

    if (packConfig.eventTypes !== false) {
      const eventManifest = packConfig.eventTypes ?? createDefaultEventTypes(slug);
      await writeJson(
        path.join(packageRoot, 'content/event-types.json'),
        eventManifest,
      );

      for (const entry of eventManifest.eventTypes) {
        const schemaPath = path.join(
          packageRoot,
          'content',
          entry.schema,
        );
        await writeJson(schemaPath, {
          type: 'object',
          properties: {},
        });
      }
    }
  }

  return {
    root,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function parseEvents(stdout: string, stderr: string): ParsedEvent[] {
  return [...parseJsonLines(stdout), ...parseJsonLines(stderr)];
}

function parseJsonLines(output: string): ParsedEvent[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce((events: ParsedEvent[], line) => {
      try {
        events.push(JSON.parse(line) as ParsedEvent);
      } catch {
        // Ignore non-JSON lines.
      }
      return events;
    }, []);
}

async function runCli(args: string[], options: { cwd: string }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      TSX_PATH,
      [CLI_PATH, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function assertFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}`, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function renderJson5Document(document: unknown): string {
  const json = JSON.stringify(document, null, 2);
  return `// json5 test document\n${json}`;
}

async function writeJson5(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const source =
    typeof data === 'string' ? data : renderJson5Document(data);
  const normalized = source.endsWith('\n') ? source : `${source}\n`;
  await fs.writeFile(filePath, normalized, 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function bumpPackVersion(root: string, slug: string, nextVersion: string): Promise<void> {
  const packFile = await readPackFile(root, slug);
  packFile.document.metadata.version = nextVersion;
  await writePackFile(packFile.path, packFile.format, packFile.document);
}

function startWatchCli(args: string[], options: { cwd: string }): WatchProcess {
  const child = spawn(
    TSX_PATH,
    [CLI_PATH, ...args],
    {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const stdoutInterface = readline.createInterface({ input: child.stdout! });
  const stderrInterface = readline.createInterface({ input: child.stderr! });
  const events = createEventCollector();

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as ParsedEvent;
      events.push(parsed);
    } catch {
      // Ignore non-JSON lines.
    }
  };

  stdoutInterface.on('line', handleLine);
  stderrInterface.on('line', handleLine);

  const cleanup = (): void => {
    stdoutInterface.off('line', handleLine);
    stderrInterface.off('line', handleLine);
    stdoutInterface.close();
    stderrInterface.close();
  };

  child.once('exit', () => {
    cleanup();
  });
  child.once('error', () => {
    cleanup();
  });

  return {
    child,
    events,
    async stop(signal: NodeJS.Signals = 'SIGINT') {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
        });
      }
    },
  };
}

interface Waiter {
  matcher: (event: ParsedEvent) => boolean;
  resolve: (event: ParsedEvent) => void;
}

function createEventCollector(): EventCollector {
  const bufferedEvents: ParsedEvent[] = [];
  const waiters: Waiter[] = [];
  const history: ParsedEvent[] = [];

  return {
    push(event: ParsedEvent) {
      history.push(event);
      for (let index = 0; index < waiters.length; index += 1) {
        const waiter = waiters[index];
        if (waiter.matcher(event)) {
          waiters.splice(index, 1);
          waiter.resolve(event);
          return;
        }
      }
      bufferedEvents.push(event);
    },
    waitForEvent(matcher: (event: ParsedEvent) => boolean, timeoutMs = 10000): Promise<ParsedEvent> {
      const existingIndex = bufferedEvents.findIndex(matcher);
      if (existingIndex !== -1) {
        const [event] = bufferedEvents.splice(existingIndex, 1);
        return Promise.resolve(event);
      }

      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          matcher,
          resolve: (event: ParsedEvent) => {
            clearTimeout(timeoutId);
            resolve(event);
          },
        };
        const timeoutId = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex !== -1) {
            waiters.splice(waiterIndex, 1);
          }
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for matching event.`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    history() {
      return history.slice();
    },
  };
}

async function rewritePackWithoutChanges(packPath: string): Promise<void> {
  const raw = await fs.readFile(packPath, 'utf8');
  const format = packPath.endsWith('.json5') ? 'json5' : 'json';
  const parsed = format === 'json5' ? JSON5.parse(raw) : JSON.parse(raw);
  await writePackFile(packPath, format, parsed);
}

async function setMissingDependency(root: string, slug: string, missingSlug: string): Promise<void> {
  const packFile = await readPackFile(root, slug);
  packFile.document.metadata.dependencies = {
    requires: [{ packId: missingSlug }],
  };
  await writePackFile(packFile.path, packFile.format, packFile.document);
}

async function readPackFile(root: string, slug: string): Promise<PackFile> {
  const contentDir = path.join(root, 'packages', slug, 'content');
  const jsonPath = path.join(contentDir, 'pack.json');
  const json5Path = path.join(contentDir, 'pack.json5');

  if (await pathExists(jsonPath)) {
    const raw = await fs.readFile(jsonPath, 'utf8');
    return {
      path: jsonPath,
      format: 'json',
      document: JSON.parse(raw) as ContentPackDocument,
    };
  }

  if (await pathExists(json5Path)) {
    const raw = await fs.readFile(json5Path, 'utf8');
    return {
      path: json5Path,
      format: 'json5',
      document: JSON5.parse(raw) as ContentPackDocument,
    };
  }

  throw new Error(`Expected pack document for ${slug}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writePackFile(filePath: string, format: 'json' | 'json5', document: ContentPackDocument): Promise<void> {
  if (format === 'json5') {
    await writeJson5(filePath, document);
    return;
  }
  await writeJson(filePath, document);
}

async function seedWorkspaceOutputs(rootDirectory: string): Promise<void> {
  const manifest = await buildRuntimeEventManifest({ rootDirectory });
  const { schemaOptions } = await withMutedConsole(() =>
    validateContentPacks(manifest.manifestDefinitions, { rootDirectory }),
  );

  await writeRuntimeEventManifest(manifest.moduleSource, { rootDirectory });
  await compileWorkspacePacks(
    { rootDirectory },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { cwd: rootDirectory, schema: schemaOptions as any },
  );
}

async function withMutedConsole<T>(action: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const noop = (): void => {};

  console.log = noop;
  console.warn = noop;
  console.error = noop;

  try {
    return await action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}
