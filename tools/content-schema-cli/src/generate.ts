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

interface BaseEventMetadataEntry {
  type: string;
  version: number;
  packSlug: string;
  schema?: string;
}

interface ContentEventDefinition {
  packSlug: string;
  type: string;
  version: number;
  schema?: string;
}

interface ManifestDefinition extends ContentEventDefinition {
  channel: number;
}

interface ManifestEntry {
  channel: number;
  type: string;
  version: number;
}

export interface BuildRuntimeEventManifestOptions {
  rootDirectory?: string;
}

export interface BuildRuntimeEventManifestResult {
  manifestDefinitions: ManifestDefinition[];
  manifestEntries: ManifestEntry[];
  manifestHash: string;
  moduleSource: string;
}

export async function buildRuntimeEventManifest(
  options: BuildRuntimeEventManifestOptions = {},
): Promise<BuildRuntimeEventManifestResult> {
  const rootDirectory = options.rootDirectory ?? DEFAULT_REPO_ROOT;
  const baseMetadata = await loadBaseMetadata(rootDirectory);
  const explicitDefinitions = await loadContentEventDefinitions(rootDirectory);
  const achievementDefinitions = await loadAchievementEventDefinitions(rootDirectory);

  // Merge definitions: explicit event-types.json takes precedence over achievement-extracted
  const explicitTypes = new Set(explicitDefinitions.map((d) => d.type));
  const contentDefinitions = [
    ...explicitDefinitions,
    ...achievementDefinitions.filter((d) => !explicitTypes.has(d.type)),
  ];

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

export interface WriteRuntimeEventManifestOptions {
  check?: boolean;
  clean?: boolean;
  rootDirectory?: string;
}

export interface WriteRuntimeEventManifestResult {
  action: 'unchanged' | 'written' | 'would-write';
  path: string;
}

export async function writeRuntimeEventManifest(
  moduleSource: string,
  options: WriteRuntimeEventManifestOptions = {},
): Promise<WriteRuntimeEventManifestResult> {
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

async function readExistingManifest(rootDirectory: string): Promise<string | undefined> {
  const targetPath = path.join(rootDirectory, GENERATED_MODULE_RELATIVE_PATH);
  try {
    return await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export interface RunGenerateOptions {
  rootDirectory?: string;
  pretty?: boolean;
  balance?: unknown;
}

export interface RunGenerateResult extends BuildRuntimeEventManifestResult {
  schemaOptions: SchemaOptions;
}

export async function runGenerate(options: RunGenerateOptions = {}): Promise<RunGenerateResult> {
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

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function loadBaseMetadata(rootDirectory: string): Promise<BaseEventMetadataEntry[]> {
  const metadataPath = path.join(rootDirectory, BASE_METADATA_RELATIVE_PATH);
  const raw = await fs.readFile(metadataPath, 'utf8');
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('Base event metadata must be an array.');
  }

  return data.map((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `Base event metadata entry at index ${index} must be an object.`,
      );
    }

    const entryObj = entry as Record<string, unknown>;
    const { type, version, packSlug, schema } = entryObj;

    if (typeof type !== 'string' || type.length === 0) {
      throw new Error(
        `Base event metadata entry at index ${index} is missing a string type.`,
      );
    }

    if (!Number.isInteger(version) || (version as number) <= 0) {
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
      version: version as number,
      packSlug: (packSlug as string | undefined) ?? '@idle-engine/core',
      schema: typeof schema === 'string' ? schema : undefined,
    };
  });
}

async function loadContentEventDefinitions(rootDirectory: string): Promise<ContentEventDefinition[]> {
  const packagesDir = path.join(rootDirectory, 'packages');
  const directories = await fs.readdir(packagesDir, { withFileTypes: true });
  const definitions: ContentEventDefinition[] = [];
  const seenEventTypes = new Map<string, string>();

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
    let manifest: unknown;
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

interface ContentPackDocument {
  metadata?: {
    id?: string;
    version?: string;
    dependencies?: {
      requires?: Array<{
        packId?: string;
        version?: string;
      }>;
    };
  };
  achievements?: Array<{
    reward?: {
      kind?: string;
      eventId?: string;
    };
    onUnlockEvents?: string[];
  }>;
}

/**
 * Extracts event IDs from achievement emitEvent rewards and onUnlockEvents arrays.
 * These are registered as schema-less events with unknown payload type.
 */
async function loadAchievementEventDefinitions(rootDirectory: string): Promise<ContentEventDefinition[]> {
  const packagesDir = path.join(rootDirectory, 'packages');
  const directories = await fs.readdir(packagesDir, { withFileTypes: true });
  const definitions: ContentEventDefinition[] = [];
  const seenEventTypes = new Set<string>();

  for (const entry of directories) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = path.join(packagesDir, entry.name);
    const packPath = await findContentPackPath(packageRoot);
    if (!packPath) {
      continue;
    }

    let document: ContentPackDocument | undefined;
    try {
      document = await readContentPackDocument(packPath);
    } catch (error) {
      // Only skip if file not found; re-throw permission/IO errors
      if (isNodeError(error) && error.code === 'ENOENT') {
        continue;
      }
      // Log non-ENOENT errors so users know why achievement events may be missing
      console.warn(formatLogPayload({
        event: 'content_pack.achievement_extraction_skipped',
        path: toPosixPath(path.relative(rootDirectory, packPath)),
        reason: error instanceof Error ? error.message : String(error),
        note: 'Pack will be validated separately; achievement events from this pack may be missing.',
      }, false));
      continue;
    }

    const packSlug = document?.metadata?.id;
    if (typeof packSlug !== 'string' || packSlug.length === 0) {
      continue;
    }

    const achievements = document?.achievements ?? [];
    for (const achievement of achievements) {
      // Extract emitEvent reward
      if (achievement?.reward?.kind === 'emitEvent') {
        const eventId = achievement.reward.eventId;
        if (typeof eventId === 'string' && eventId.length > 0 && !seenEventTypes.has(eventId)) {
          seenEventTypes.add(eventId);
          definitions.push({
            packSlug,
            type: eventId,
            version: 1,
            schema: undefined,
          });
        }
      }

      // Extract onUnlockEvents
      const onUnlockEvents = achievement?.onUnlockEvents ?? [];
      for (const eventId of onUnlockEvents) {
        if (typeof eventId === 'string' && eventId.length > 0 && !seenEventTypes.has(eventId)) {
          seenEventTypes.add(eventId);
          definitions.push({
            packSlug,
            type: eventId,
            version: 1,
            schema: undefined,
          });
        }
      }
    }
  }

  definitions.sort((left, right) => {
    if (left.packSlug !== right.packSlug) {
      return left.packSlug < right.packSlug ? -1 : 1;
    }
    return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
  });

  return definitions;
}

function buildManifestDefinitions(
  baseMetadata: BaseEventMetadataEntry[],
  contentDefinitions: ContentEventDefinition[],
): ManifestDefinition[] {
  const manifestDefinitions: ManifestDefinition[] = [];

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

interface EventTypeManifest {
  packSlug?: unknown;
  eventTypes?: unknown;
}

interface EventTypeEntry {
  namespace?: unknown;
  name?: unknown;
  version?: unknown;
  schema?: unknown;
}

async function validateContentManifest(
  manifest: unknown,
  manifestPath: string,
  definitions: ContentEventDefinition[],
  seenEventTypes: Map<string, string>,
  rootDirectory: string,
): Promise<void> {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error(
      `Manifest ${toPosixPath(path.relative(rootDirectory, manifestPath))} must export an object.`,
    );
  }

  const manifestObj = manifest as EventTypeManifest;
  const { packSlug, eventTypes } = manifestObj;

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
    const entry = eventTypes[index] as unknown;
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `Event type at index ${index} in ${toPosixPath(
          path.relative(rootDirectory, manifestPath),
        )} must be an object.`,
      );
    }

    const entryObj = entry as EventTypeEntry;
    const { namespace, name, version, schema } = entryObj;

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

    if (!Number.isInteger(version) || (version as number) <= 0) {
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
      version: version as number,
      schema: toPosixPath(path.relative(rootDirectory, schemaPath)),
    });
    seenEventTypes.set(eventType, packSlug);
  }
}

function computeManifestHash(entries: ManifestEntry[]): string {
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

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash;
}

interface RenderModuleInput {
  baseMetadata: BaseEventMetadataEntry[];
  contentDefinitions: ContentEventDefinition[];
  manifestDefinitions: ManifestDefinition[];
  manifestEntries: ManifestEntry[];
  manifestHash: string;
}

function renderModule({
  contentDefinitions,
  manifestDefinitions,
  manifestEntries,
  manifestHash,
}: RenderModuleInput): string {
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
    '  readonly schema?: string;',
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
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function formatContentDefinitions(definitions: ContentEventDefinition[]): string {
  if (definitions.length === 0) {
    return '[]';
  }

  const entries = definitions
    .map((definition) => {
      const lines = [
        '  {',
        `    packSlug: '${escapeString(definition.packSlug)}',`,
        `    type: '${escapeString(definition.type)}' as RuntimeEventType,`,
        `    version: ${definition.version},`,
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

function formatContentChannels(definitions: ContentEventDefinition[]): string {
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

function formatManifestDefinitions(definitions: ManifestDefinition[]): string {
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

function formatManifestEntries(entries: ManifestEntry[]): string {
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

function escapeString(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

interface ContentPackDocumentEntry {
  status: 'ok' | 'error';
  packageRoot: string;
  packPath: string;
  document?: ContentPackDocument;
  metadata?: {
    packSlug?: string;
    packVersion?: string;
  };
  error?: Error;
}

async function loadContentPackDocuments(rootDirectory: string): Promise<ContentPackDocumentEntry[]> {
  const packs: ContentPackDocumentEntry[] = [];
  const packRoots = [
    ...(await listPackDirectories(path.join(rootDirectory, 'packages'))),
    ...(await listPackDirectories(path.join(rootDirectory, 'docs/examples'))),
  ];

  packRoots.sort((left, right) =>
    toPosixPath(path.relative(rootDirectory, left)).localeCompare(
      toPosixPath(path.relative(rootDirectory, right)),
    ),
  );

  for (const packageRoot of packRoots) {
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

async function listPackDirectories(baseDirectory: string): Promise<string[]> {
  if (!(await fileExists(baseDirectory))) {
    return [];
  }
  const entries = await fs.readdir(baseDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDirectory, entry.name));
}

async function findContentPackPath(packageRoot: string): Promise<string | undefined> {
  for (const relativePath of CONTENT_PACK_FILENAMES) {
    const candidate = path.join(packageRoot, relativePath);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function readContentPackDocument(packPath: string): Promise<ContentPackDocument> {
  const raw = await fs.readFile(packPath, 'utf8');
  if (packPath.toLowerCase().endsWith('.json5')) {
    return JSON5.parse(raw) as ContentPackDocument;
  }
  return JSON.parse(raw) as ContentPackDocument;
}

function extractDocumentMetadata(document: ContentPackDocument | undefined): {
  packSlug?: string;
  packVersion?: string;
} {
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

interface KnownPackEntry {
  id: string;
  version: string;
  requires?: Array<{
    packId: string;
    version?: string;
  }>;
}

function extractKnownPackEntries(documents: ContentPackDocumentEntry[]): KnownPackEntry[] {
  return documents
    .map((entry): KnownPackEntry | undefined => {
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
              .map((dependency): { packId: string; version?: string } | undefined => {
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
              .filter((value): value is { packId: string; version?: string } => value !== undefined)
          : undefined;

      return requires && requires.length === 0
        ? { id, version }
        : {
            id,
            version,
            requires,
          };
    })
    .filter((entry): entry is KnownPackEntry => entry !== undefined);
}

interface ValidationFailure {
  packSlug: string;
  packVersion?: string;
  path: string;
  message: string;
  issues?: unknown[];
}

export class ContentPackValidationError extends Error {
  readonly failures: readonly ValidationFailure[];

  constructor(message: string, { failures }: { failures: ValidationFailure[] }) {
    super(message);
    this.name = 'ContentPackValidationError';
    this.failures = Object.freeze([...failures]);
  }
}

interface SchemaOptions {
  knownPacks: KnownPackEntry[];
  activePackIds: string[];
  runtimeEventCatalogue: string[];
  runtimeVersion: string;
  balance?: unknown;
}

export interface ValidateContentPacksOptions {
  pretty?: boolean;
  rootDirectory?: string;
  balance?: unknown;
}

export interface ValidateContentPacksResult {
  schemaOptions: SchemaOptions;
}

export async function validateContentPacks(
  manifestDefinitions: ManifestDefinition[],
  options: ValidateContentPacksOptions = {},
): Promise<ValidateContentPacksResult> {
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

  const schemaOptions: SchemaOptions = {
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

  // ContentSchemaOptions uses branded PackId types, but our local SchemaOptions uses plain strings.
  // The runtime values are compatible; double cast is required to bridge branded type mismatch.
  const validator = createContentPackValidator(schemaOptions as unknown as Parameters<typeof createContentPackValidator>[0]);
  const failures: ValidationFailure[] = [];

  for (const entry of documents) {
    const relativePath = toPosixPath(
      path.relative(rootDirectory, entry.packPath),
    );

    if (entry.status === 'error') {
      const failurePayload = createValidationFailurePayload({
        relativePath,
        metadata: undefined,
        packageRoot: entry.packageRoot,
        message: entry.error!.message,
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

    const validationError = result.error as { message: string; issues?: unknown[] };
    const failurePayload = createValidationFailurePayload({
      relativePath,
      metadata: entry.metadata,
      packageRoot: entry.packageRoot,
      message: validationError.message,
      issues: validationError.issues,
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

function formatLogPayload(payload: unknown, pretty: boolean): string {
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined);
}

interface CreateValidationFailurePayloadInput {
  relativePath: string;
  metadata?: {
    packSlug?: string;
    packVersion?: string;
  };
  packageRoot: string;
  message: string;
  issues?: unknown[];
}

function createValidationFailurePayload({
  relativePath,
  metadata,
  packageRoot,
  message,
  issues,
}: CreateValidationFailurePayloadInput): {
  log: Record<string, unknown>;
  summary: ValidationFailure;
} {
  const packSlug =
    metadata?.packSlug ?? inferPackSlugFromPackageRoot(packageRoot);
  const packVersion = metadata?.packVersion;

  const logPayload: Record<string, unknown> = {
    event: 'content_pack.validation_failed',
    path: relativePath,
    message,
    ...(packSlug ? { packSlug } : {}),
    ...(typeof packVersion === 'string' ? { packVersion } : {}),
    ...(issues !== undefined ? { issues } : {}),
  };

  const summaryEntry: ValidationFailure = {
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

function inferPackSlugFromPackageRoot(packageRoot: string): string {
  return path.basename(packageRoot);
}

function inferPackSlugFromRelativePath(relativePath: string): string {
  const segments = relativePath.split('/');
  if (segments.length >= 3) {
    return segments[1];
  }
  return relativePath;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

if (isExecutedDirectly(import.meta.url)) {
  runGenerate().catch((error) => {
    logUnhandledError(error, false);
    process.exitCode = 1;
  });
}

function isExecutedDirectly(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return false;
  }
  return moduleUrl === pathToFileURL(scriptPath).href;
}

interface NormalizedError {
  name?: string;
  message: string;
  stack?: string;
}

function logUnhandledError(error: unknown, pretty: boolean): void {
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

function normalizeError(error: unknown): NormalizedError {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
