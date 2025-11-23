#!/usr/bin/env node

import { BalanceValidationError, createContentPackValidator } from '@idle-engine/content-schema';
import { RUNTIME_VERSION } from '@idle-engine/core';
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

export async function buildRuntimeEventManifest(options = {}) {
  const rootDirectory = options.rootDirectory ?? DEFAULT_REPO_ROOT;
  const baseMetadata = await loadBaseMetadata(rootDirectory);
  const contentDefinitions = await loadContentEventDefinitions(rootDirectory);
  const manifestDefinitions = buildManifestDefinitions(
    baseMetadata,
    contentDefinitions,
  );
  const manifestEntries = manifestDefinitions.map(
    ({ channel, type, version }) => ({ channel, type, version }),
  );
  const manifestHash = computeManifestHash(manifestEntries);

  const fileContents = renderModule({
    baseMetadata,
    contentDefinitions,
    manifestDefinitions,
    manifestEntries,
    manifestHash,
  });

  return {
    manifestDefinitions,
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
  const manifest = await buildRuntimeEventManifest(options);
  const validation = await validateContentPacks(
    manifest.manifestDefinitions,
    options,
  );
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
  directories.sort((left, right) => left.name.localeCompare(right.name));
  const packs = [];

  for (const entry of directories) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = path.join(packagesDir, entry.name);
    const packPath = await findContentPackPath(packageRoot);
    if (!packPath) {
      continue;
    }

    try {
      const document = await readContentPackDocument(packPath);
      packs.push({
        status: 'ok',
        packageRoot,
        packPath,
        document,
        metadata: extractDocumentMetadata(document),
      });
    } catch (error) {
      packs.push({
        status: 'error',
        packageRoot,
        packPath,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return packs;
}

async function findContentPackPath(packageRoot) {
  for (const relativePath of CONTENT_PACK_FILENAMES) {
    const candidate = path.join(packageRoot, relativePath);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function readContentPackDocument(packPath) {
  const raw = await fs.readFile(packPath, 'utf8');
  if (packPath.toLowerCase().endsWith('.json5')) {
    return JSON5.parse(raw);
  }
  return JSON.parse(raw);
}

function extractDocumentMetadata(document) {
  const metadata = document?.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return {
      packSlug: undefined,
      packVersion: undefined,
    };
  }

  const packSlug =
    typeof metadata.id === 'string' && metadata.id.length > 0
      ? metadata.id
      : undefined;
  const packVersion =
    typeof metadata.version === 'string' && metadata.version.length > 0
      ? metadata.version
      : undefined;

  return {
    packSlug,
    packVersion,
  };
}

function extractKnownPackEntries(documents) {
  return documents
    .map((entry) => {
      const metadata = entry?.document?.metadata;
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
              .map((dependency) => {
                if (typeof dependency !== 'object' || dependency === null) {
                  return undefined;
                }
                const { packId, version: requirementVersion } = dependency;
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

export class ContentPackValidationError extends Error {
  constructor(message, { failures }) {
    super(message);
    this.name = 'ContentPackValidationError';
    this.failures = Object.freeze([...failures]);
  }
}

export async function validateContentPacks(manifestDefinitions, options = {}) {
  const { pretty = false } = options;
  const rootDirectory = options.rootDirectory ?? DEFAULT_REPO_ROOT;
  const balanceOptions = options.balance;

  const documents = await loadContentPackDocuments(rootDirectory);
  const validDocuments = documents.filter((entry) => entry.status === 'ok');
  const runtimeEventCatalogue = manifestDefinitions.map(
    (definition) => definition.type,
  );
  const knownPacks = extractKnownPackEntries(validDocuments);
  const activePackIds = knownPacks.map((entry) => entry.id);

  const schemaOptions = {
    knownPacks,
    activePackIds,
    runtimeEventCatalogue,
    runtimeVersion: RUNTIME_VERSION,
    ...(balanceOptions !== undefined ? { balance: balanceOptions } : {}),
  };

  if (validDocuments.length === 0 && documents.length === 0) {
    return {
      schemaOptions,
    };
  }

  const validator = createContentPackValidator(schemaOptions);
  const failures = [];

  for (const entry of documents) {
    const relativePath = toPosixPath(
      path.relative(rootDirectory, entry.packPath),
    );

    if (entry.status === 'error') {
      const failurePayload = createValidationFailurePayload({
        relativePath,
        metadata: undefined,
        packageRoot: entry.packageRoot,
        message: entry.error.message,
        issues: undefined,
      });
      console.error(formatLogPayload(failurePayload.log, pretty));
      failures.push(failurePayload.summary);
      continue;
    }

    const result = validator.safeParse(entry.document);
    if (result.success) {
      const {
        pack,
        warnings,
        balanceWarnings,
        balanceErrors,
      } = result.data;
      const balanceWarningCount = balanceWarnings.length;
      const balanceErrorCount = balanceErrors.length;
      const warningCount = warnings.length + balanceWarningCount + balanceErrorCount;
      if (balanceWarningCount > 0) {
        const balanceWarningPayload = {
          event: 'content_pack.balance_warning',
          packSlug: pack.metadata.id,
          packVersion: pack.metadata.version,
          path: relativePath,
          warningCount: balanceWarningCount,
          warnings: balanceWarnings,
        };
        console.warn(formatLogPayload(balanceWarningPayload, pretty));
      }
      if (balanceErrorCount > 0) {
        const balanceErrorPayload = {
          event: 'content_pack.balance_failed',
          packSlug: pack.metadata.id,
          packVersion: pack.metadata.version,
          path: relativePath,
          errorCount: balanceErrorCount,
          errors: balanceErrors,
        };
        console.error(formatLogPayload(balanceErrorPayload, pretty));
      }
      const payload = {
        event: 'content_pack.validated',
        packSlug: pack.metadata.id,
        packVersion: pack.metadata.version,
        path: relativePath,
        warningCount,
        balanceWarningCount,
        balanceErrorCount,
        warnings,
        balanceWarnings,
        balanceErrors,
      };
      if (warningCount > 0) {
        console.warn(formatLogPayload(payload, pretty));
      } else {
        console.log(formatLogPayload(payload, pretty));
      }
      continue;
    }

    if (result.error instanceof BalanceValidationError) {
      const balanceIssues = result.error.issues;
      if (balanceIssues && balanceIssues.length > 0) {
        const balanceErrorPayload = {
          event: 'content_pack.balance_failed',
          packSlug: entry.metadata?.packSlug ?? inferPackSlugFromRelativePath(relativePath),
          ...(entry.metadata?.packVersion
            ? { packVersion: entry.metadata.packVersion }
            : {}),
          path: relativePath,
          errorCount: balanceIssues.length,
          errors: balanceIssues,
        };
        console.error(formatLogPayload(balanceErrorPayload, pretty));
      }
    }

    const failurePayload = createValidationFailurePayload({
      relativePath,
      metadata: entry.metadata,
      packageRoot: entry.packageRoot,
      message: result.error.message,
      issues: result.error.issues,
    });
    console.error(formatLogPayload(failurePayload.log, pretty));
    failures.push(failurePayload.summary);
  }

  if (failures.length > 0) {
    throw new ContentPackValidationError(
      'One or more content packs failed validation; see logs for details.',
      { failures },
    );
  }

  return {
    schemaOptions,
  };
}

function formatLogPayload(payload, pretty) {
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

function createValidationFailurePayload({
  relativePath,
  metadata,
  packageRoot,
  message,
  issues,
}) {
  const packSlug =
    metadata?.packSlug ?? inferPackSlugFromPackageRoot(packageRoot);
  const packVersion = metadata?.packVersion;

  const logPayload = {
    event: 'content_pack.validation_failed',
    path: relativePath,
    message,
    ...(packSlug ? { packSlug } : {}),
    ...(typeof packVersion === 'string' ? { packVersion } : {}),
    ...(issues !== undefined ? { issues } : {}),
  };

  const summaryEntry = {
    packSlug: packSlug ?? inferPackSlugFromRelativePath(relativePath),
    ...(packVersion ? { packVersion } : {}),
    path: relativePath,
    message,
    ...(issues !== undefined ? { issues } : {}),
  };

  return {
    log: logPayload,
    summary: summaryEntry,
  };
}

function inferPackSlugFromPackageRoot(packageRoot) {
  return path.basename(packageRoot);
}

function inferPackSlugFromRelativePath(relativePath) {
  const segments = relativePath.split('/');
  if (segments.length >= 3) {
    return segments[1];
  }
  return relativePath;
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
    logUnhandledError(error, false);
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

function logUnhandledError(error, pretty) {
  const normalized = normalizeError(error);
  const payload = {
    event: 'cli.unhandled_error',
    message: normalized.message,
    timestamp: new Date().toISOString(),
    fatal: true,
    ...(normalized.name ? { name: normalized.name } : {}),
    ...(normalized.stack ? { stack: normalized.stack } : {}),
  };
  console.error(formatLogPayload(payload, pretty));
}

function normalizeError(error) {
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
