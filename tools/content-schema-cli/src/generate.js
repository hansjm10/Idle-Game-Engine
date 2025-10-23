#!/usr/bin/env node

import { createContentPackValidator } from '@idle-engine/content-schema';
import JSON5 from 'json5';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../../..');
const BASE_METADATA_RELATIVE_PATH =
  'packages/core/src/events/runtime-event-base-metadata.json';
const GENERATED_MODULE_RELATIVE_PATH =
  'packages/core/src/events/runtime-event-manifest.generated.ts';
const CONTENT_PACK_FILENAMES = ['content/pack.json', 'content/pack.json5'];
const VALIDATION_ERROR_NAME = 'ContentPackValidationError';
const VALIDATION_ERROR_CODE = 'CONTENT_PACK_VALIDATION_FAILED';

export async function loadRuntimeEventManifestContext(options = {}) {
  const rootDirectory = options.rootDirectory ?? DEFAULT_REPO_ROOT;
  const baseMetadata = await loadBaseMetadata(rootDirectory);
  const contentDefinitions = await loadContentEventDefinitions(rootDirectory);
  const manifestDefinitions = buildManifestDefinitions(
    baseMetadata,
    contentDefinitions,
  );
  return {
    baseMetadata,
    contentDefinitions,
    manifestDefinitions,
  };
}

export async function buildRuntimeEventManifest(options = {}) {
  const rootDirectory = options.rootDirectory ?? DEFAULT_REPO_ROOT;
  const manifestContext =
    options.manifestContext ??
    (await loadRuntimeEventManifestContext({ rootDirectory }));
  const manifestEntries = manifestContext.manifestDefinitions.map(
    ({ channel, type, version }) => ({ channel, type, version }),
  );
  const manifestHash = computeManifestHash(manifestEntries);

  const fileContents = renderModule({
    baseMetadata: manifestContext.baseMetadata,
    contentDefinitions: manifestContext.contentDefinitions,
    manifestDefinitions: manifestContext.manifestDefinitions,
    manifestEntries,
    manifestHash,
  });

  return {
    manifestDefinitions: manifestContext.manifestDefinitions,
    manifestEntries,
    manifestHash,
    moduleSource: fileContents,
  };
}

export async function writeRuntimeEventManifest(moduleSource, options = {}) {
  const { check = false, clean = false } = options;
  const rootDirectory = options.rootDirectory ?? DEFAULT_REPO_ROOT;
  const targetPath = path.join(rootDirectory, GENERATED_MODULE_RELATIVE_PATH);
  const existing = await readExistingManifest(rootDirectory);
  const identical = existing === moduleSource;
  const relativePath = toPosixPath(
    path.relative(rootDirectory, targetPath),
  );

  if (check) {
    return {
      action: identical ? 'unchanged' : 'would-write',
      path: relativePath,
    };
  }

  if (identical && !clean) {
    return {
      action: 'unchanged',
      path: relativePath,
    };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, moduleSource, 'utf8');
  return {
    action: 'written',
    path: relativePath,
  };
}

async function readExistingManifest(rootDirectory) {
  const targetPath = path.join(rootDirectory, GENERATED_MODULE_RELATIVE_PATH);
  try {
    return await fs.readFile(targetPath, 'utf8');
  } catch {
    return undefined;
  }
}

export async function runGenerate(options = {}) {
  const manifestContext = await loadRuntimeEventManifestContext(options);
  const validation = await validateContentPacks(
    manifestContext.manifestDefinitions,
    options,
  );
  const manifest = await buildRuntimeEventManifest({
    ...options,
    manifestContext,
  });
  await writeRuntimeEventManifest(manifest.moduleSource, options);
  return {
    ...manifest,
    schemaOptions: validation.schemaOptions,
  };
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

async function loadBaseMetadata(rootDirectory) {
  const metadataPath = path.join(rootDirectory, BASE_METADATA_RELATIVE_PATH);
  const raw = await fs.readFile(metadataPath, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('Base event metadata must be an array.');
  }

  return data.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `Base event metadata entry at index ${index} must be an object.`,
      );
    }

    const { type, version, packSlug, schema } = entry;

    if (typeof type !== 'string' || type.length === 0) {
      throw new Error(
        `Base event metadata entry at index ${index} is missing a string type.`,
      );
    }

    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(
        `Base event metadata entry at index ${index} must provide a positive integer version.`,
      );
    }

    if (packSlug !== undefined && typeof packSlug !== 'string') {
      throw new Error(
        `Base event metadata entry at index ${index} has an invalid packSlug.`,
      );
    }

    if (schema !== undefined && schema !== null && typeof schema !== 'string') {
      throw new Error(
        `Base event metadata entry at index ${index} has an invalid schema reference.`,
      );
    }

    return {
      type,
      version,
      packSlug: packSlug ?? '@idle-engine/core',
      schema: typeof schema === 'string' ? schema : undefined,
    };
  });
}

async function loadContentEventDefinitions(rootDirectory) {
  const packagesDir = path.join(rootDirectory, 'packages');
  const directories = await fs.readdir(packagesDir, { withFileTypes: true });
  const definitions = [];
  const seenEventTypes = new Map();

  for (const entry of directories) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageRoot = path.join(packagesDir, entry.name);
    const manifestPath = path.join(packageRoot, 'content/event-types.json');
    if (!(await fileExists(manifestPath))) {
      continue;
    }

    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (error) {
      throw new Error(
        `Failed to parse ${toPosixPath(path.relative(rootDirectory, manifestPath))}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await validateContentManifest(
      manifest,
      manifestPath,
      definitions,
      seenEventTypes,
      rootDirectory,
    );
  }

  definitions.sort((left, right) => {
    if (left.packSlug !== right.packSlug) {
      return left.packSlug < right.packSlug ? -1 : 1;
    }
    return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
  });

  return definitions;
}

function buildManifestDefinitions(baseMetadata, contentDefinitions) {
  const manifestDefinitions = [];

  let channel = 0;
  for (const entry of baseMetadata) {
    manifestDefinitions.push({
      channel,
      type: entry.type,
      version: entry.version,
      packSlug: entry.packSlug,
      schema: entry.schema,
    });
    channel += 1;
  }

  for (const entry of contentDefinitions) {
    manifestDefinitions.push({
      channel,
      type: entry.type,
      version: entry.version,
      packSlug: entry.packSlug,
      schema: entry.schema,
    });
    channel += 1;
  }

  return manifestDefinitions;
}

async function validateContentManifest(
  manifest,
  manifestPath,
  definitions,
  seenEventTypes,
  rootDirectory,
) {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error(
      `Manifest ${toPosixPath(path.relative(rootDirectory, manifestPath))} must export an object.`,
    );
  }

  const { packSlug, eventTypes } = manifest;

  if (typeof packSlug !== 'string' || packSlug.length === 0) {
    throw new Error(
      `Manifest ${toPosixPath(path.relative(rootDirectory, manifestPath))} must declare a non-empty packSlug.`,
    );
  }

  if (!Array.isArray(eventTypes)) {
    throw new Error(
      `Manifest ${toPosixPath(path.relative(rootDirectory, manifestPath))} must declare an eventTypes array.`,
    );
  }

  const manifestDir = path.dirname(manifestPath);

  for (let index = 0; index < eventTypes.length; index += 1) {
    const entry = eventTypes[index];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `Event type at index ${index} in ${toPosixPath(
          path.relative(rootDirectory, manifestPath),
        )} must be an object.`,
      );
    }

    const { namespace, name, version, schema } = entry;

    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new Error(
        `Event type at index ${index} in ${toPosixPath(
          path.relative(rootDirectory, manifestPath),
        )} is missing a namespace.`,
      );
    }

    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `Event type at index ${index} in ${toPosixPath(
          path.relative(rootDirectory, manifestPath),
        )} is missing a name.`,
      );
    }

    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(
        `Event type ${namespace}:${name} in ${toPosixPath(
          path.relative(rootDirectory, manifestPath),
        )} must provide a positive integer version.`,
      );
    }

    if (typeof schema !== 'string' || schema.length === 0) {
      throw new Error(
        `Event type ${namespace}:${name} in ${toPosixPath(
          path.relative(rootDirectory, manifestPath),
        )} must reference a schema path.`,
      );
    }

    const eventType = `${namespace}:${name}`;
    const previous = seenEventTypes.get(eventType);
    if (previous) {
      throw new Error(
        `Event type ${eventType} is already declared by ${previous}; duplicates are not allowed.`,
      );
    }

    const schemaPath = path.resolve(manifestDir, schema);
    if (!(await fileExists(schemaPath))) {
      throw new Error(
        `Schema ${toPosixPath(
          path.relative(rootDirectory, schemaPath),
        )} referenced by ${eventType} does not exist.`,
      );
    }
    definitions.push({
      packSlug,
      type: eventType,
      version,
      schema: toPosixPath(path.relative(rootDirectory, schemaPath)),
    });
    seenEventTypes.set(eventType, packSlug);
  }
}

function computeManifestHash(entries) {
  const sorted = [...entries].sort((left, right) => {
    if (left.channel !== right.channel) {
      return left.channel - right.channel;
    }
    if (left.type !== right.type) {
      return left.type < right.type ? -1 : 1;
    }
    return left.version - right.version;
  });

  const serialized = sorted
    .map((entry) => `${entry.channel}:${entry.type}:${entry.version}`)
    .join('|');

  return fnv1a(serialized).toString(16).padStart(8, '0');
}

function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash;
}

function renderModule({
  baseMetadata,
  contentDefinitions,
  manifestDefinitions,
  manifestEntries,
  manifestHash,
}) {
  const contentDefinitionsLiteral = formatContentDefinitions(contentDefinitions);
  const contentChannelsLiteral = formatContentChannels(contentDefinitions);
  const manifestEntriesLiteral = formatManifestEntries(manifestEntries);
  const manifestDefinitionsLiteral =
    formatManifestDefinitions(manifestDefinitions);

  const contentTypeUnion =
    contentDefinitions.length === 0
      ? 'never'
      : contentDefinitions
          .map((definition) => `'${escapeString(definition.type)}'`)
          .join(' | ');

  const moduleAugmentationLines =
    contentDefinitions.length === 0
      ? []
      : [
          "declare module './runtime-event.js' {",
          '  interface RuntimeEventPayloadMap {',
          ...contentDefinitions.map(
            (definition) =>
              `    '${escapeString(definition.type)}': unknown;`,
          ),
          '  }',
          '}',
        ];

  return [
    '/* @generated */',
    '// This file was auto-generated by pnpm generate.',
    '// Do not edit this file directly.',
    "import type { EventChannelConfiguration } from './event-bus.js';",
    "import type { RuntimeEventManifestEntry, RuntimeEventManifestHash, RuntimeEventType } from './runtime-event.js';",
    '',
    'export interface ContentEventDefinition {',
    '  readonly packSlug: string;',
    '  readonly type: RuntimeEventType;',
    '  readonly version: number;',
    '  readonly schema: string;',
    '}',
    '',
    'export interface GeneratedRuntimeEventDefinition {',
    '  readonly channel: number;',
    '  readonly type: RuntimeEventType;',
    '  readonly version: number;',
    '  readonly packSlug: string;',
    '  readonly schema?: string;',
    '}',
    '',
    `export const CONTENT_EVENT_DEFINITIONS = ${contentDefinitionsLiteral} as const satisfies readonly ContentEventDefinition[];`,
    '',
    `export const CONTENT_EVENT_CHANNELS: ReadonlyArray<EventChannelConfiguration> = ${contentChannelsLiteral};`,
    '',
    `export const GENERATED_RUNTIME_EVENT_DEFINITIONS = ${manifestDefinitionsLiteral} as const satisfies readonly GeneratedRuntimeEventDefinition[];`,
    '',
    'export const GENERATED_RUNTIME_EVENT_MANIFEST = {',
    `  entries: ${manifestEntriesLiteral},`,
    `  hash: '${manifestHash}' as RuntimeEventManifestHash,`,
    '} as const;',
    '',
    'export type ContentRuntimeEventType =',
    `  ${contentTypeUnion};`,
    '',
    ...moduleAugmentationLines,
    moduleAugmentationLines.length > 0 ? '' : undefined,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

function formatContentDefinitions(definitions) {
  if (definitions.length === 0) {
    return '[]';
  }

  const entries = definitions
    .map(
      (definition) => [
        '  {',
        `    packSlug: '${escapeString(definition.packSlug)}',`,
        `    type: '${escapeString(definition.type)}' as RuntimeEventType,`,
        `    version: ${definition.version},`,
        `    schema: '${escapeString(definition.schema)}',`,
        '  }',
      ].join('\n'),
    )
    .join(',\n');

  return `[\n${entries},\n]`;
}

function formatContentChannels(definitions) {
  if (definitions.length === 0) {
    return '[]';
  }

  const entries = definitions
    .map(
      (definition) => [
        '  {',
        '    definition: {',
        `      type: '${escapeString(definition.type)}' as RuntimeEventType,`,
        `      version: ${definition.version},`,
        '    },',
        '  }',
      ].join('\n'),
    )
    .join(',\n');

  return `[\n${entries},\n]`;
}

function formatManifestDefinitions(definitions) {
  if (definitions.length === 0) {
    return '[]';
  }

  const entries = definitions
    .map((definition) => {
      const lines = [
        '  {',
        `    channel: ${definition.channel},`,
        `    type: '${escapeString(definition.type)}' as RuntimeEventType,`,
        `    version: ${definition.version},`,
        `    packSlug: '${escapeString(definition.packSlug)}',`,
      ];
      if (definition.schema) {
        lines.push(`    schema: '${escapeString(definition.schema)}',`);
      }
      lines.push('  }');
      return lines.join('\n');
    })
    .join(',\n');

  return `[\n${entries},\n]`;
}

function formatManifestEntries(entries) {
  if (entries.length === 0) {
    return '[] as const satisfies readonly RuntimeEventManifestEntry[]';
  }

  const formatted = entries
    .map(
      (entry) => [
        '    {',
        `      channel: ${entry.channel},`,
        `      type: '${escapeString(entry.type)}' as RuntimeEventType,`,
        `      version: ${entry.version},`,
        '    }',
      ].join('\n'),
    )
    .join(',\n');

  return `[\n${formatted},\n  ] as const satisfies readonly RuntimeEventManifestEntry[]`;
}

function escapeString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

async function loadContentPackDocuments(rootDirectory) {
  const packagesDir = path.join(rootDirectory, 'packages');
  const directories = await fs.readdir(packagesDir, { withFileTypes: true });
  const packs = [];

  for (const entry of directories) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = path.join(packagesDir, entry.name);
    const packPath = await resolveContentPackPath(packageRoot);
    if (!packPath) {
      continue;
    }

    const document = await loadPackDocument(packPath, rootDirectory);

    packs.push({
      packageRoot,
      packPath,
      document,
    });
  }

  return packs;
}

async function resolveContentPackPath(packageRoot) {
  for (const relative of CONTENT_PACK_FILENAMES) {
    const candidate = path.join(packageRoot, relative);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function loadPackDocument(packPath, rootDirectory) {
  const raw = await fs.readFile(packPath, 'utf8');
  try {
    return packPath.endsWith('.json5') ? JSON5.parse(raw) : JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse content pack ${toPosixPath(
        path.relative(rootDirectory, packPath),
      )}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function extractKnownPackEntries(documents) {
  return documents
    .map((document) => {
      const metadata = document?.document?.metadata;
      if (typeof metadata !== 'object' || metadata === null) {
        return undefined;
      }

      const { id, version, dependencies } = metadata;
      if (typeof id !== 'string' || typeof version !== 'string') {
        return undefined;
      }

      const requires =
        Array.isArray(dependencies?.requires) && dependencies.requires.length > 0
          ? dependencies.requires
              .map((entry) => {
                if (typeof entry !== 'object' || entry === null) {
                  return undefined;
                }
                const { packId, version: requirementVersion } = entry;
                if (typeof packId !== 'string') {
                  return undefined;
                }
                return {
                  packId,
                  version:
                    typeof requirementVersion === 'string'
                      ? requirementVersion
                      : undefined,
                };
              })
              .filter((value) => value !== undefined)
          : undefined;

      return requires && requires.length === 0
        ? { id, version }
        : {
            id,
            version,
            requires,
          };
    })
    .filter((entry) => entry !== undefined);
}

export async function validateContentPacks(manifestDefinitions, options = {}) {
  const { pretty = false } = options;
  const rootDirectory = options.rootDirectory ?? DEFAULT_REPO_ROOT;

  const documents = await loadContentPackDocuments(rootDirectory);
  const runtimeEventCatalogue = manifestDefinitions.map(
    (definition) => definition.type,
  );

  if (documents.length === 0) {
    return {
      schemaOptions: {
        knownPacks: [],
        activePackIds: [],
        runtimeEventCatalogue,
      },
    };
  }

  const knownPacks = extractKnownPackEntries(documents);
  const activePackIds = knownPacks.map((entry) => entry.id);

  const validator = createContentPackValidator({
    knownPacks,
    activePackIds,
    runtimeEventCatalogue,
  });

  const failures = [];

  for (const document of documents) {
    const { packPath } = document;
    const result = validator.safeParse(document.document);
    const relativePath = toPosixPath(path.relative(rootDirectory, packPath));
    if (result.success) {
      const { pack, warnings } = result.data;
      const payload = {
        event: 'content_pack.validated',
        packSlug: pack.metadata.id,
        path: relativePath,
        warningCount: warnings.length,
        warnings,
      };
      if (warnings.length > 0) {
        console.warn(formatLogPayload(payload, pretty));
      } else {
        console.log(formatLogPayload(payload, pretty));
      }
      continue;
    }

    const payload = {
      event: 'content_pack.validation_failed',
      path: relativePath,
      issues: result.error.issues,
      message: result.error.message,
    };
    console.error(formatLogPayload(payload, pretty));
    failures.push(payload);
  }

  if (failures.length > 0) {
    throw createContentValidationError();
  }

  return {
    schemaOptions: {
      knownPacks,
      activePackIds,
      runtimeEventCatalogue,
    },
  };
}

function createContentValidationError() {
  const error = new Error(
    'One or more content packs failed validation; see logs for details.',
  );
  error.name = VALIDATION_ERROR_NAME;
  error.code = VALIDATION_ERROR_CODE;
  return error;
}

export function isContentValidationError(error) {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const name = /** @type {{ name?: unknown }} */ (error).name;
  if (name === VALIDATION_ERROR_NAME) {
    return true;
  }
  const code = /** @type {{ code?: unknown }} */ (error).code;
  return code === VALIDATION_ERROR_CODE;
}

function formatLogPayload(payload, pretty) {
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

if (isExecutedDirectly(import.meta.url)) {
  runGenerate().catch((error) => {
    if (!isContentValidationError(error)) {
      console.error(error instanceof Error ? error.stack : error);
    }
    process.exitCode = 1;
  });
}

function isExecutedDirectly(moduleUrl) {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return false;
  }
  return moduleUrl === pathToFileURL(scriptPath).href;
}
