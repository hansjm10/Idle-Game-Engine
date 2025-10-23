import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

    await writeJson(
      path.join(packageRoot, 'content/pack.json'),
      document,
    );

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

async function bumpPackVersion(root, slug, nextVersion) {
  const packPath = path.join(root, 'packages', slug, 'content/pack.json');
  const raw = await fs.readFile(packPath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.metadata.version = nextVersion;
  await writeJson(packPath, parsed);
}
