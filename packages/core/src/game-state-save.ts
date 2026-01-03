import type {
  AutomationState,
  SerializedAutomationState,
} from './automation-system.js';
import { serializeAutomationState } from './automation-system.js';
import type {
  CommandQueue,
  SerializedCommandQueue,
} from './command-queue.js';
import type { SerializedProductionAccumulators } from './production-system.js';
import type { ProgressionCoordinator } from './progression-coordinator.js';
import {
  hydrateProgressionCoordinatorState,
  serializeProgressionCoordinatorState,
  type SerializedProgressionCoordinatorState,
} from './progression-coordinator-save.js';
import type { SerializedResourceState } from './resource-state.js';
import { getCurrentRNGSeed, setRNGSeed } from './rng.js';
import type { SerializedTransformState, TransformState } from './transform-system.js';
import { serializeTransformState } from './transform-system.js';
import type { EntitySystem, SerializedEntitySystemState } from './entity-system.js';

export const GAME_STATE_SAVE_SCHEMA_VERSION = 1;

export type GameStateSaveRuntime = Readonly<{
  step: number;
  rngSeed?: number;
}>;

export type GameStateSaveFormatV1 = Readonly<{
  readonly version: 1;
  readonly savedAt: number;
  readonly resources: SerializedResourceState;
  readonly progression: SerializedProgressionCoordinatorState;
  readonly automation: readonly SerializedAutomationState[];
  readonly transforms: readonly SerializedTransformState[];
  readonly entities: SerializedEntitySystemState;
  readonly commandQueue: SerializedCommandQueue;
  readonly runtime: GameStateSaveRuntime;
}>;

export type GameStateSaveFormat = GameStateSaveFormatV1;

export interface SchemaMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (data: unknown) => unknown;
}

interface LegacyGameStateSaveFormatV0 {
  readonly savedAt?: number;
  readonly resources: SerializedResourceState;
  readonly progression: SerializedProgressionCoordinatorState;
  readonly automation?: readonly SerializedAutomationState[];
  readonly transforms?: readonly SerializedTransformState[];
  readonly commandQueue: SerializedCommandQueue;
  readonly runtime?: GameStateSaveRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function readNonNegativeInt(value: unknown): number | undefined {
  const numberValue = readFiniteNumber(value);
  if (numberValue === undefined || numberValue < 0) {
    return undefined;
  }
  return Math.floor(numberValue);
}

function getSaveVersion(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readNonNegativeInt(value.version);
}

function hasLegacyV0Shape(value: unknown): value is LegacyGameStateSaveFormatV0 {
  if (!isRecord(value)) {
    return false;
  }

  return (
    'resources' in value &&
    'progression' in value &&
    'commandQueue' in value
  );
}

function stripEmbeddedAutomation(
  value: SerializedResourceState,
): SerializedResourceState {
  if (!isRecord(value)) {
    return value;
  }

  if (!('automationState' in value)) {
    return value;
  }

  const { automationState: _automationState, ...rest } = value as SerializedResourceState & {
    automationState?: unknown;
  };

  return rest as SerializedResourceState;
}

function normalizeRuntime(value: unknown): GameStateSaveRuntime {
  if (!isRecord(value)) {
    return { step: 0 };
  }

  const step = readNonNegativeInt(value.step) ?? 0;
  const rngSeed = readFiniteNumber(value.rngSeed);

  return {
    step,
    ...(rngSeed !== undefined ? { rngSeed } : {}),
  };
}

function migrateLegacyV0ToV1(value: unknown): GameStateSaveFormatV1 {
  if (!hasLegacyV0Shape(value)) {
    throw new Error('Unsupported legacy game state save format.');
  }

  const legacy = value;
  const savedAt = readFiniteNumber(legacy.savedAt) ?? 0;
  const runtime = normalizeRuntime(legacy.runtime);

  const resources = stripEmbeddedAutomation(legacy.resources);
  const progression = isRecord(legacy.progression)
    ? ({
        ...(legacy.progression as Record<string, unknown>),
        resources: stripEmbeddedAutomation(
          (legacy.progression as { resources: SerializedResourceState }).resources,
        ),
      } as SerializedProgressionCoordinatorState)
    : legacy.progression;

  const embeddedAutomation = isRecord(legacy.resources)
    ? (legacy.resources as { automationState?: unknown }).automationState
    : undefined;

  const automation = Array.isArray(legacy.automation)
    ? legacy.automation
    : Array.isArray(embeddedAutomation)
      ? (embeddedAutomation as SerializedAutomationState[])
      : [];

  const entities: SerializedEntitySystemState = {
    entities: [],
    instances: [],
    entityInstances: [],
  };

  return {
    version: GAME_STATE_SAVE_SCHEMA_VERSION,
    savedAt,
    resources,
    progression,
    automation,
    transforms: Array.isArray(legacy.transforms) ? legacy.transforms : [],
    entities,
    commandQueue: legacy.commandQueue,
    runtime,
  };
}

export const DEFAULT_GAME_STATE_SAVE_MIGRATIONS: readonly SchemaMigration[] =
  Object.freeze([
    {
      fromVersion: 0,
      toVersion: GAME_STATE_SAVE_SCHEMA_VERSION,
      migrate: migrateLegacyV0ToV1,
    },
  ]);

function findMigrationPath(
  migrations: readonly SchemaMigration[],
  fromVersion: number,
  toVersion: number,
): readonly SchemaMigration[] | undefined {
  if (fromVersion === toVersion) {
    return [];
  }

  const migrationsByFrom = new Map<number, SchemaMigration[]>();
  for (const migration of migrations) {
    const list = migrationsByFrom.get(migration.fromVersion);
    if (list) {
      list.push(migration);
    } else {
      migrationsByFrom.set(migration.fromVersion, [migration]);
    }
  }

  const queue: Array<{ version: number; path: SchemaMigration[] }> = [
    { version: fromVersion, path: [] },
  ];
  const visited = new Set<number>([fromVersion]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const nextMigrations = migrationsByFrom.get(current.version) ?? [];
    for (const migration of nextMigrations) {
      if (visited.has(migration.toVersion)) {
        continue;
      }

      const path = [...current.path, migration];
      if (migration.toVersion === toVersion) {
        return path;
      }

      visited.add(migration.toVersion);
      queue.push({ version: migration.toVersion, path });
    }
  }

  return undefined;
}

function validateSaveFormatV1(value: unknown): GameStateSaveFormatV1 {
  if (!isRecord(value)) {
    throw new Error('Save data must be an object.');
  }

  if (value.version !== GAME_STATE_SAVE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported game state save version: ${String(value.version)}`,
    );
  }

  const savedAt = readFiniteNumber(value.savedAt);
  if (savedAt === undefined || savedAt < 0) {
    throw new Error('Save data has an invalid savedAt timestamp.');
  }

  const runtime = normalizeRuntime(value.runtime);

  if (!('resources' in value)) {
    throw new Error('Save data is missing resources.');
  }

  if (!('progression' in value)) {
    throw new Error('Save data is missing progression state.');
  }

  if (!('commandQueue' in value)) {
    throw new Error('Save data is missing command queue state.');
  }

  return {
    version: GAME_STATE_SAVE_SCHEMA_VERSION,
    savedAt,
    resources: value.resources as SerializedResourceState,
    progression: value.progression as SerializedProgressionCoordinatorState,
    automation: Array.isArray(value.automation)
      ? (value.automation as SerializedAutomationState[])
      : [],
    transforms: Array.isArray(value.transforms)
      ? (value.transforms as SerializedTransformState[])
      : [],
    entities: isRecord(value.entities)
      ? {
          entities: Array.isArray(value.entities.entities)
            ? (value.entities.entities as SerializedEntitySystemState['entities'])
            : [],
          instances: Array.isArray(value.entities.instances)
            ? (value.entities.instances as SerializedEntitySystemState['instances'])
            : [],
          entityInstances: Array.isArray(value.entities.entityInstances)
            ? (value.entities.entityInstances as SerializedEntitySystemState['entityInstances'])
            : [],
        }
      : { entities: [], instances: [], entityInstances: [] },
    commandQueue: value.commandQueue as SerializedCommandQueue,
    runtime,
  };
}

export function loadGameStateSaveFormat(
  value: unknown,
  options: {
    readonly migrations?: readonly SchemaMigration[];
    readonly targetVersion?: number;
  } = {},
): GameStateSaveFormat {
  const targetVersion =
    options.targetVersion ?? GAME_STATE_SAVE_SCHEMA_VERSION;
  const migrations = options.migrations ?? DEFAULT_GAME_STATE_SAVE_MIGRATIONS;

  const detectedVersion = getSaveVersion(value);
  const fromVersion =
    detectedVersion ?? (hasLegacyV0Shape(value) ? 0 : undefined);

  if (fromVersion === undefined) {
    throw new Error('Unable to determine game state save version.');
  }

  let migrated: unknown = value;

  if (fromVersion !== targetVersion) {
    const path = findMigrationPath(migrations, fromVersion, targetVersion);
    if (!path) {
      throw new Error(
        `No migration path from version ${fromVersion} to ${targetVersion}.`,
      );
    }

    let currentVersion = fromVersion;
    for (const migration of path) {
      migrated = migration.migrate(migrated);
      const nextVersion = getSaveVersion(migrated);
      if (nextVersion !== migration.toVersion) {
        throw new Error(
          `Migration from ${currentVersion} to ${migration.toVersion} did not set the expected version.`,
        );
      }
      currentVersion = nextVersion;
    }
  }

  return validateSaveFormatV1(migrated);
}

export interface SerializeGameStateSaveFormatOptions {
  readonly runtimeStep: number;
  readonly savedAt?: number;
  readonly rngSeed?: number;
  readonly coordinator: ProgressionCoordinator;
  readonly productionSystem?: {
    exportAccumulators: () => SerializedProductionAccumulators;
  };
  readonly automationState?: ReadonlyMap<string, AutomationState>;
  readonly transformState?: ReadonlyMap<string, TransformState>;
  readonly entitySystem?: EntitySystem;
  readonly commandQueue: CommandQueue;
}

export function serializeGameStateSaveFormat(
  options: SerializeGameStateSaveFormatOptions,
): GameStateSaveFormatV1 {
  const savedAt = readFiniteNumber(options.savedAt) ?? Date.now();
  const runtimeStep = readNonNegativeInt(options.runtimeStep) ?? 0;
  const rngSeed = options.rngSeed ?? getCurrentRNGSeed();

  return {
    version: GAME_STATE_SAVE_SCHEMA_VERSION,
    savedAt,
    resources: options.coordinator.resourceState.exportForSave(),
    progression: serializeProgressionCoordinatorState(
      options.coordinator,
      options.productionSystem,
    ),
    automation: options.automationState
      ? serializeAutomationState(options.automationState)
      : [],
    transforms: options.transformState
      ? serializeTransformState(options.transformState)
      : [],
    entities: options.entitySystem
      ? options.entitySystem.exportForSave()
      : { entities: [], instances: [], entityInstances: [] },
    commandQueue: options.commandQueue.exportForSave(),
    runtime: {
      step: runtimeStep,
      ...(rngSeed !== undefined ? { rngSeed } : {}),
    },
  };
}

export interface HydrateGameStateSaveFormatOptions {
  readonly save: GameStateSaveFormat;
  readonly coordinator: ProgressionCoordinator;
  readonly productionSystem?: {
    restoreAccumulators: (state: SerializedProductionAccumulators) => void;
  };
  readonly automationSystem?: {
    restoreState: (
      state: readonly SerializedAutomationState[],
      options?: { savedWorkerStep?: number; currentStep?: number },
    ) => void;
  };
  readonly transformSystem?: {
    restoreState: (
      state: readonly SerializedTransformState[],
      options?: { savedWorkerStep?: number; currentStep?: number },
    ) => void;
  };
  readonly entitySystem?: EntitySystem;
  readonly commandQueue?: CommandQueue;
  readonly currentStep?: number;
  readonly applyRngSeed?: boolean;
}

export function hydrateGameStateSaveFormat(
  options: HydrateGameStateSaveFormatOptions,
): void {
  const { save } = options;
  const currentStep = options.currentStep ?? save.runtime.step;

  if (options.applyRngSeed !== false && save.runtime.rngSeed !== undefined) {
    setRNGSeed(save.runtime.rngSeed);
  }

  options.coordinator.hydrateResources(save.resources);
  hydrateProgressionCoordinatorState(
    save.progression,
    options.coordinator,
    options.productionSystem,
    { skipResources: true },
  );

  if (options.automationSystem) {
    options.automationSystem.restoreState(save.automation, {
      savedWorkerStep: save.runtime.step,
      currentStep,
    });
  }

  if (options.transformSystem) {
    options.transformSystem.restoreState(save.transforms, {
      savedWorkerStep: save.runtime.step,
      currentStep,
    });
  }

  if (options.entitySystem) {
    options.entitySystem.restoreState(save.entities, {
      savedWorkerStep: save.runtime.step,
      currentStep,
    });
  }

  if (options.commandQueue) {
    options.commandQueue.restoreFromSave(save.commandQueue, {
      rebaseStep: { savedStep: save.runtime.step, currentStep },
    });
  }
}

export type GameStateSaveCompression = 'none' | 'gzip';

const enum SaveCompressionHeader {
  None = 0,
  Gzip = 1,
}

function coerceBlobBytes(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (payload.buffer instanceof ArrayBuffer) {
    return payload as Uint8Array<ArrayBuffer>;
  }

  return new Uint8Array(payload) as Uint8Array<ArrayBuffer>;
}

async function gzipCompress(payload: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'function') {
    throw new Error('CompressionStream is not available in this environment.');
  }

  const stream = new Blob([coerceBlobBytes(payload)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function gzipDecompress(payload: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'DecompressionStream is not available in this environment.',
    );
  }

  const stream = new Blob([coerceBlobBytes(payload)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function encodeGameStateSave(
  save: GameStateSaveFormat,
  options: { readonly compression?: GameStateSaveCompression } = {},
): Promise<Uint8Array> {
  const json = JSON.stringify(save);
  const payload = new TextEncoder().encode(json);
  const compression = options.compression ?? 'none';

  if (compression === 'gzip') {
    const compressed = await gzipCompress(payload);
    const buffer = new Uint8Array(compressed.length + 1);
    buffer[0] = SaveCompressionHeader.Gzip;
    buffer.set(compressed, 1);
    return buffer;
  }

  const buffer = new Uint8Array(payload.length + 1);
  buffer[0] = SaveCompressionHeader.None;
  buffer.set(payload, 1);
  return buffer;
}

export async function decodeGameStateSave(
  encoded: Uint8Array,
  options: {
    readonly migrations?: readonly SchemaMigration[];
    readonly targetVersion?: number;
  } = {},
): Promise<GameStateSaveFormat> {
  if (!(encoded instanceof Uint8Array) || encoded.length === 0) {
    throw new Error('Encoded save must be a non-empty Uint8Array.');
  }

  const header = encoded[0];
  const payload = encoded.slice(1);

  let jsonPayload: Uint8Array;
  if (header === SaveCompressionHeader.None) {
    jsonPayload = payload;
  } else if (header === SaveCompressionHeader.Gzip) {
    jsonPayload = await gzipDecompress(payload);
  } else {
    throw new Error(
      `Unsupported save compression header: ${String(header)}`,
    );
  }

  const json = new TextDecoder().decode(jsonPayload);
  const parsed = JSON.parse(json) as unknown;
  return loadGameStateSaveFormat(parsed, options);
}
