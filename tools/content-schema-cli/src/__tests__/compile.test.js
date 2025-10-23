import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import JSON5 from 'json5';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../compile.js');

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
    } finally {
      await workspace.cleanup();
    }
  });

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
  });

  it('emits structured cli.unhandled_error events when manifest generation fails', async () => {
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
  });

  it('writes a failure summary when validation fails', async () => {
    const workspace = await createWorkspace([
      {
        slug: 'invalid-pack',
        overrides: {
          resources: null,
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

      const summaryPath = path.join(workspace.root, 'content/compiled/index.json');
      const summaryRaw = await fs.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(summaryRaw);
      const summaryEntry = summary.packs.find(
        (pack) => pack.slug === 'invalid-pack',
      );
      expect(summaryEntry?.status).toBe('failed');
      expect(typeof summaryEntry?.error).toBe('string');
    } finally {
      await workspace.cleanup();
    }
  });

  it('writes a failure summary in check mode', async () => {
    const workspace = await createWorkspace([
      {
        slug: 'invalid-pack',
        overrides: {
          resources: null,
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

      const summaryPath = path.join(
        workspace.root,
        'content/compiled/index.json',
      );
      const summaryRaw = await fs.readFile(summaryPath, 'utf8');
      const summary = JSON.parse(summaryRaw);
      const summaryEntry = summary.packs.find(
        (pack) => pack.slug === 'invalid-pack',
      );
      expect(summaryEntry?.status).toBe('failed');
      expect(typeof summaryEntry?.error).toBe('string');
    } finally {
      await workspace.cleanup();
    }
  });

  it('reports drift in check mode', async () => {
    const workspace = await createWorkspace([
      { slug: 'beta-pack' },
    ]);

    try {
      const initial = await runCli(['--cwd', workspace.root], { cwd: workspace.root });
      expect(initial.code).toBe(0);

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
      expect(
        compileEvent?.artifacts.some((artifact) => artifact.action === 'would-write'),
      ).toBe(true);

      const skippedEvent = events.find(
        (entry) =>
          entry.name === 'content_pack.skipped' && entry.slug === 'beta-pack',
      );
      expect(skippedEvent).toBeUndefined();
    } finally {
      await workspace.cleanup();
    }
  });

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
        },
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
    } finally {
      await workspace.cleanup();
    }
  });

  it('emits watch run events for changes, skips, and repeated failures with aggregated triggers', async () => {
    const packSlug = 'watch-pack';
    const workspace = await createWorkspace([{ slug: packSlug }]);
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
      );
      await watchProcess.events.waitForEvent(
        (event) => event.event === 'watch.hint',
      );
      await watchProcess.events.waitForEvent(
        (event) =>
          event.name === 'content_pack.compiled' && event.slug === packSlug,
      );

      await sleep(200);
      await Promise.all([
        bumpPackVersion(workspace.root, packSlug, '0.0.2'),
        writeJson(bonusPath, { generated: true }),
      ]);

      const successRun = await watchProcess.events.waitForEvent(
        (event) =>
          event.event === 'watch.run' && event.status === 'success',
      );
      expect(successRun.changedPacks).toEqual(
        expect.arrayContaining([packSlug]),
      );
      expect(successRun.artifacts?.changed ?? 0).toBeGreaterThan(0);
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
      );
      expect(skippedRun.artifacts?.changed ?? 0).toBe(0);
      expect(skippedRun.triggers?.count ?? 0).toBeGreaterThan(0);

      await sleep(200);
      await setMissingDependency(workspace.root, packSlug, 'missing-pack');

      await watchProcess.events.waitForEvent(
        (event) =>
          event.name === 'content_pack.compilation_failed' &&
          event.slug === packSlug,
      );

      const failureRun = await watchProcess.events.waitForEvent(
        (event) =>
          event.event === 'watch.run' && event.status === 'failed',
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
  }, 20000);
});

function createPackDocument(id, overrides = {}) {
  const baseDocument = {
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
    guildPerks: [],
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

function createDefaultEventTypes(slug) {
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

async function createWorkspace(packs) {
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

function parseEvents(stdout, stderr) {
  return [...parseJsonLines(stdout), ...parseJsonLines(stderr)];
}

function parseJsonLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce((events, line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore non-JSON lines.
      }
      return events;
    }, []);
}

async function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
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

async function assertFileExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}`, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function renderJson5Document(document) {
  const json = JSON.stringify(document, null, 2);
  return `// json5 test document\n${json}`;
}

async function writeJson5(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const source =
    typeof data === 'string' ? data : renderJson5Document(data);
  const normalized = source.endsWith('\n') ? source : `${source}\n`;
  await fs.writeFile(filePath, normalized, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function bumpPackVersion(root, slug, nextVersion) {
  const packFile = await readPackFile(root, slug);
  packFile.document.metadata.version = nextVersion;
  await writePackFile(packFile.path, packFile.format, packFile.document);
}

function startWatchCli(args, options) {
  const child = spawn(
    process.execPath,
    [CLI_PATH, ...args],
    {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const stdoutInterface = readline.createInterface({ input: child.stdout });
  const stderrInterface = readline.createInterface({ input: child.stderr });
  const events = createEventCollector();

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      events.push(parsed);
    } catch {
      // Ignore non-JSON lines.
    }
  };

  stdoutInterface.on('line', handleLine);
  stderrInterface.on('line', handleLine);

  const cleanup = () => {
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
    async stop(signal = 'SIGINT') {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        await new Promise((resolve) => {
          child.once('exit', () => resolve());
        });
      }
    },
  };
}

function createEventCollector() {
  const bufferedEvents = [];
  const waiters = [];
  const history = [];

  return {
    push(event) {
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
    waitForEvent(matcher, timeoutMs = 10000) {
      const existingIndex = bufferedEvents.findIndex(matcher);
      if (existingIndex !== -1) {
        const [event] = bufferedEvents.splice(existingIndex, 1);
        return Promise.resolve(event);
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          matcher,
          resolve: (event) => {
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

async function rewritePackWithoutChanges(packPath) {
  const raw = await fs.readFile(packPath, 'utf8');
  const format = packPath.endsWith('.json5') ? 'json5' : 'json';
  const parsed = format === 'json5' ? JSON5.parse(raw) : JSON.parse(raw);
  await writePackFile(packPath, format, parsed);
}

async function setMissingDependency(root, slug, missingSlug) {
  const packFile = await readPackFile(root, slug);
  packFile.document.metadata.dependencies = {
    requires: [{ packId: missingSlug }],
  };
  await writePackFile(packFile.path, packFile.format, packFile.document);
}

async function readPackFile(root, slug) {
  const contentDir = path.join(root, 'packages', slug, 'content');
  const jsonPath = path.join(contentDir, 'pack.json');
  const json5Path = path.join(contentDir, 'pack.json5');

  if (await pathExists(jsonPath)) {
    const raw = await fs.readFile(jsonPath, 'utf8');
    return {
      path: jsonPath,
      format: 'json',
      document: JSON.parse(raw),
    };
  }

  if (await pathExists(json5Path)) {
    const raw = await fs.readFile(json5Path, 'utf8');
    return {
      path: json5Path,
      format: 'json5',
      document: JSON5.parse(raw),
    };
  }

  throw new Error(`Expected pack document for ${slug}`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writePackFile(filePath, format, document) {
  if (format === 'json5') {
    await writeJson5(filePath, document);
    return;
  }
  await writeJson(filePath, document);
}
