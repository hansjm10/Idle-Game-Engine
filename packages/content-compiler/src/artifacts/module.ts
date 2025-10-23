import type {
  ModuleIndexTables,
  NormalizedContentPack,
  SerializedPackArtifact,
} from '../types.js';

export interface ModuleEmitOptions {
  readonly packSlug: string;
  readonly artifact: SerializedPackArtifact;
}

export function createGeneratedModuleSource(
  options: ModuleEmitOptions,
): string {
  const constantBase = toConstantBase(options.packSlug);
  const serializedLiteral = formatSerializedLiteral(options.artifact.canonicalJson);
  const packConst = constantBase;
  const digestConst = `${constantBase}_DIGEST`;
  const hashConst = `${constantBase}_ARTIFACT_HASH`;
  const indicesConst = `${constantBase}_INDICES`;
  const summaryConst = `${constantBase}_SUMMARY`;
  const lines = [
    "import {",
    "  createModuleIndices,",
    "  rehydrateNormalizedPack,",
    "  type SerializedNormalizedContentPack,",
    "} from '@idle-engine/content-compiler/runtime';",
    '',
    `const serialized: SerializedNormalizedContentPack = ${serializedLiteral};`,
    '',
    'const runtimeEnv = (globalThis as typeof globalThis & {',
    '  process?: { env?: Record<string, string | undefined> };',
    '}).process;',
    '',
    'const shouldVerifyDigest = runtimeEnv?.env?.NODE_ENV !== \'production\';',
    '',
    `export const ${packConst} = rehydrateNormalizedPack(serialized, {`,
    '  verifyDigest: shouldVerifyDigest,',
    '});',
    `export const ${digestConst} = serialized.digest;`,
    `export const ${hashConst} = serialized.artifactHash;`,
    `export const ${indicesConst} = createModuleIndices(${packConst});`,
    `export const ${summaryConst} = ${createSummaryLiteral()};`,
    '',
  ];

  return `${lines.join('\n')}\n`;
}

type ModuleWithId = Readonly<{ id: string }>;

function buildIndex<T extends ModuleWithId>(items: readonly T[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();

  items.forEach((item, position) => {
    index.set(item.id, position);
  });

  return index;
}

export function createModuleIndices(
  pack: NormalizedContentPack,
): ModuleIndexTables {
  return {
    resources: buildIndex(pack.resources),
    generators: buildIndex(pack.generators),
    upgrades: buildIndex(pack.upgrades),
    metrics: buildIndex(pack.metrics),
    achievements: buildIndex(pack.achievements),
    automations: buildIndex(pack.automations),
    transforms: buildIndex(pack.transforms),
    prestigeLayers: buildIndex(pack.prestigeLayers),
    guildPerks: buildIndex(pack.guildPerks),
    runtimeEvents: buildIndex(pack.runtimeEvents),
  };
}

function formatSerializedLiteral(canonicalJson: string): string {
  const parsed = JSON.parse(canonicalJson) as unknown;
  return JSON.stringify(parsed, null, 2);
}

function createSummaryLiteral(): string {
  return [
    'Object.freeze({',
    '  slug: serialized.metadata.id,',
    '  version: serialized.metadata.version,',
    '  digest: serialized.digest,',
    '  artifactHash: serialized.artifactHash,',
    '  warningCount: serialized.warnings.length,',
    '  resourceIds: serialized.modules.resources.map((resource) => resource.id),',
    '})',
  ].join('\n');
}

function toConstantBase(slug: string): string {
  const encodeCharacter = (char: string): string => {
    if (/^[a-zA-Z0-9]$/.test(char)) {
      return char.toUpperCase();
    }
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      return '';
    }
    const hex = codePoint.toString(16).toUpperCase();
    const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
    return `_U${padded}_`;
  };

  const normalized = Array.from(slug).map(encodeCharacter).join('');
  if (normalized.length === 0) {
    return 'CONTENT_PACK';
  }
  if (!/^[A-Z]/.test(normalized[0] ?? '')) {
    return `PACK_${normalized}`;
  }
  return normalized;
}
