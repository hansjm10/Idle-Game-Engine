import { computeContentDigest } from './digest.js';
import {
  MODULE_NAMES,
  SERIALIZED_PACK_FORMAT_VERSION,
  type ModuleName,
  type ModuleIndexTables,
  type NormalizedContentPack,
  type RehydrateOptions,
  type SerializedContentDigest,
  type SerializedNormalizedContentPack,
  type SerializedNormalizedModules,
} from './types.js';

type LookupKey = Extract<keyof NormalizedContentPack['lookup'], string>;
type SerializedLookupKey = Extract<
  keyof NormalizedContentPack['serializedLookup'],
  string
>;

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      deepFreeze(item);
    });
  } else if (value instanceof Map) {
    value.forEach((mapValue, mapKey) => {
      deepFreeze(mapKey);
      deepFreeze(mapValue);
    });
  } else if (value instanceof Set) {
    value.forEach((setValue) => {
      deepFreeze(setValue);
    });
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.value !== undefined) {
        deepFreeze(descriptor.value);
      }
    }
  }

  return Object.freeze(value);
}

function cloneDigest(digest: SerializedContentDigest): SerializedContentDigest {
  return Object.freeze({
    version: digest.version,
    hash: digest.hash,
  });
}

const LOOKUP_PROPERTY: Record<ModuleName, LookupKey> = {
  resources: 'resources',
  generators: 'generators',
  upgrades: 'upgrades',
  metrics: 'metrics',
  achievements: 'achievements',
  automations: 'automations',
  transforms: 'transforms',
  prestigeLayers: 'prestigeLayers',
  guildPerks: 'guildPerks',
  runtimeEvents: 'runtimeEvents',
};

const SERIALIZED_LOOKUP_PROPERTY: Record<ModuleName, SerializedLookupKey> = {
  resources: 'resourceById',
  generators: 'generatorById',
  upgrades: 'upgradeById',
  metrics: 'metricById',
  achievements: 'achievementById',
  automations: 'automationById',
  transforms: 'transformById',
  prestigeLayers: 'prestigeLayerById',
  guildPerks: 'guildPerkById',
  runtimeEvents: 'runtimeEventById',
};

function extractModuleEntryId<Name extends ModuleName>(
  entry: SerializedNormalizedModules[Name][number],
  packId: string,
  moduleName: Name,
  position: number,
): string {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(
      `Serialized ${moduleName} entry at index ${position} in pack ${packId} is not an object.`,
    );
  }

  const entryId = (entry as { id?: unknown }).id;

  if (typeof entryId !== 'string' || entryId.length === 0) {
    throw new Error(
      `Serialized ${moduleName} entry at index ${position} in pack ${packId} is missing a valid id.`,
    );
  }

  return entryId;
}

function cloneModuleArray<Name extends ModuleName>(
  modules: SerializedNormalizedModules,
  name: Name,
): SerializedNormalizedModules[Name] {
  const moduleEntries = modules[name];
  const clonedEntries = moduleEntries.map((entry) => deepFreeze(entry));
  return Object.freeze(clonedEntries) as SerializedNormalizedModules[Name];
}

function cloneModuleArrays(
  modules: SerializedNormalizedModules,
): SerializedNormalizedModules {
  const cloned = Object.create(null) as Record<
    ModuleName,
    SerializedNormalizedModules[ModuleName]
  >;

  for (const name of MODULE_NAMES) {
    cloned[name] = cloneModuleArray(modules, name);
  }

  return Object.freeze(cloned) as SerializedNormalizedModules;
}

function createLookupRecords(
  packModules: SerializedNormalizedModules,
  packId: string,
) {
  const lookup = Object.create(null) as Record<LookupKey, unknown>;
  const serializedLookup = Object.create(null) as Record<SerializedLookupKey, unknown>;

  for (const name of MODULE_NAMES) {
    const entries = packModules[name];
    const map = new Map<string, (typeof entries)[number]>();
    const record: Record<string, (typeof entries)[number]> = Object.create(null);
    const mapKey = LOOKUP_PROPERTY[name];
    const recordKey = SERIALIZED_LOOKUP_PROPERTY[name];

    entries.forEach((entry, position) => {
      const entryId = extractModuleEntryId(entry, packId, name, position);
      if (map.has(entryId)) {
        throw new Error(
          `Duplicate ${name} id "${entryId}" detected while rehydrating pack ${packId}.`,
        );
      }
      map.set(entryId, entry);
      record[entryId] = entry;
    });

    lookup[mapKey] = Object.freeze(map);
    serializedLookup[recordKey] = Object.freeze(record);
  }

  return {
    lookup: Object.freeze(lookup) as NormalizedContentPack['lookup'],
    serializedLookup: Object.freeze(serializedLookup) as NormalizedContentPack['serializedLookup'],
  };
}

function resolveModulesObject(
  packModules: SerializedNormalizedModules,
): SerializedNormalizedModules {
  return Object.freeze({
    resources: packModules.resources,
    generators: packModules.generators,
    upgrades: packModules.upgrades,
    metrics: packModules.metrics,
    achievements: packModules.achievements,
    automations: packModules.automations,
    transforms: packModules.transforms,
    prestigeLayers: packModules.prestigeLayers,
    guildPerks: packModules.guildPerks,
    runtimeEvents: packModules.runtimeEvents,
  });
}

export function rehydrateNormalizedPack(
  serialized: SerializedNormalizedContentPack,
  options?: RehydrateOptions,
): NormalizedContentPack {
  if (serialized.formatVersion !== SERIALIZED_PACK_FORMAT_VERSION) {
    throw new Error(
      `Unsupported serialized content pack format ${serialized.formatVersion}. Expected ${SERIALIZED_PACK_FORMAT_VERSION}.`,
    );
  }

  const clonedModules = cloneModuleArrays(serialized.modules);
  const packId = serialized.metadata.id;
  const { lookup, serializedLookup } = createLookupRecords(clonedModules, packId);
  const digestInput = {
    metadata: serialized.metadata,
    modules: clonedModules,
  } as const;
  const computedDigest = computeContentDigest(digestInput);
  const serializedDigest = serialized.digest;
  const shouldVerify = options?.verifyDigest === true;

  if (
    serializedDigest !== undefined &&
    serializedDigest.version !== computedDigest.version
  ) {
    throw new Error(
      `Serialized digest version ${serializedDigest.version} does not match supported version ${computedDigest.version} for pack ${serialized.metadata.id}.`,
    );
  }

  if (shouldVerify) {
    if (serializedDigest === undefined) {
      throw new Error(
        `Digest verification requested for pack ${serialized.metadata.id}, but the serialized payload does not include a digest.`,
      );
    }

    if (computedDigest.hash !== serializedDigest.hash) {
      throw new Error(
        `Digest mismatch for pack ${serialized.metadata.id}: expected ${computedDigest.hash}, received ${serializedDigest.hash}`,
      );
    }
  }

  const digestSource = shouldVerify
    ? computedDigest
    : serializedDigest ?? computedDigest;

  // TODO(#159): Add artifact hash verification once canonical serialization wiring is complete.

  const digest = cloneDigest(digestSource);

  const modulesObject = resolveModulesObject(clonedModules);

  const pack: NormalizedContentPack = Object.freeze({
    metadata: serialized.metadata,
    resources: clonedModules.resources,
    generators: clonedModules.generators,
    upgrades: clonedModules.upgrades,
    metrics: clonedModules.metrics,
    achievements: clonedModules.achievements,
    automations: clonedModules.automations,
    transforms: clonedModules.transforms,
    prestigeLayers: clonedModules.prestigeLayers,
    guildPerks: clonedModules.guildPerks,
    runtimeEvents: clonedModules.runtimeEvents,
    modules: modulesObject,
    lookup,
    serializedLookup,
    digest,
  });

  return pack;
}

function buildModuleIndex<Name extends ModuleName>(
  pack: NormalizedContentPack,
  name: Name,
): ReadonlyMap<string, number> {
  const modules = (pack as { readonly modules?: SerializedNormalizedModules }).modules;
  const entries =
    (modules?.[name] ?? pack[name]) as SerializedNormalizedModules[Name];
  const index = new Map<string, number>();

  entries.forEach((entry, position) => {
    const entryId = extractModuleEntryId(entry, pack.metadata.id, name, position);
    if (index.has(entryId)) {
      throw new Error(
        `Duplicate ${name} id "${entryId}" detected while building indices for pack ${pack.metadata.id}.`,
      );
    }
    index.set(entryId, position);
  });

  return Object.freeze(index);
}

export function createModuleIndices(
  pack: NormalizedContentPack,
): ModuleIndexTables {
  const tables = Object.create(null) as Record<ModuleName, ReadonlyMap<string, number>>;

  for (const name of MODULE_NAMES) {
    tables[name] = buildModuleIndex(pack, name);
  }

  return Object.freeze(tables) as ModuleIndexTables;
}
