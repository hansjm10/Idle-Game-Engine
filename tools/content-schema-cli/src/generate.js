#!/usr/bin/env node

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BASE_METADATA_PATH = path.join(
  REPO_ROOT,
  'packages/core/src/events/runtime-event-base-metadata.json',
);
const GENERATED_MODULE_PATH = path.join(
  REPO_ROOT,
  'packages/core/src/events/runtime-event-manifest.generated.ts',
);

async function main() {
  const baseMetadata = await loadBaseMetadata();
  const contentDefinitions = await loadContentEventDefinitions();
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

  await fs.mkdir(path.dirname(GENERATED_MODULE_PATH), { recursive: true });
  await fs.writeFile(GENERATED_MODULE_PATH, fileContents, 'utf8');
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

async function loadBaseMetadata() {
  const raw = await fs.readFile(BASE_METADATA_PATH, 'utf8');
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

async function loadContentEventDefinitions() {
  const packagesDir = path.join(REPO_ROOT, 'packages');
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
        `Failed to parse ${toPosixPath(path.relative(REPO_ROOT, manifestPath))}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await validateContentManifest(
      manifest,
      manifestPath,
      definitions,
      seenEventTypes,
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
) {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error(
      `Manifest ${toPosixPath(path.relative(REPO_ROOT, manifestPath))} must export an object.`,
    );
  }

  const { packSlug, eventTypes } = manifest;

  if (typeof packSlug !== 'string' || packSlug.length === 0) {
    throw new Error(
      `Manifest ${toPosixPath(path.relative(REPO_ROOT, manifestPath))} must declare a non-empty packSlug.`,
    );
  }

  if (!Array.isArray(eventTypes)) {
    throw new Error(
      `Manifest ${toPosixPath(path.relative(REPO_ROOT, manifestPath))} must declare an eventTypes array.`,
    );
  }

  const manifestDir = path.dirname(manifestPath);

  for (let index = 0; index < eventTypes.length; index += 1) {
    const entry = eventTypes[index];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `Event type at index ${index} in ${toPosixPath(
          path.relative(REPO_ROOT, manifestPath),
        )} must be an object.`,
      );
    }

    const { namespace, name, version, schema } = entry;

    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new Error(
        `Event type at index ${index} in ${toPosixPath(
          path.relative(REPO_ROOT, manifestPath),
        )} is missing a namespace.`,
      );
    }

    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `Event type at index ${index} in ${toPosixPath(
          path.relative(REPO_ROOT, manifestPath),
        )} is missing a name.`,
      );
    }

    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(
        `Event type ${namespace}:${name} in ${toPosixPath(
          path.relative(REPO_ROOT, manifestPath),
        )} must provide a positive integer version.`,
      );
    }

    if (typeof schema !== 'string' || schema.length === 0) {
      throw new Error(
        `Event type ${namespace}:${name} in ${toPosixPath(
          path.relative(REPO_ROOT, manifestPath),
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
          path.relative(REPO_ROOT, schemaPath),
        )} referenced by ${eventType} does not exist.`,
      );
    }
    definitions.push({
      packSlug,
      type: eventType,
      version,
      schema: toPosixPath(path.relative(REPO_ROOT, schemaPath)),
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

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
