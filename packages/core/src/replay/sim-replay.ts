import type { NormalizedContentPack } from '@idle-engine/content-schema';

import { CommandPriority, type Command } from '../command.js';
import type { GameRuntimeWiring } from '../game-runtime-wiring.js';
import { telemetry } from '../telemetry.js';
import { captureGameStateSnapshot } from '../state-sync/capture.js';
import { computeStateChecksum } from '../state-sync/checksum.js';
import { restoreGameRuntimeFromSnapshot } from '../state-sync/restore-runtime.js';
import type { GameStateSnapshot } from '../state-sync/types.js';
import { RUNTIME_VERSION } from '../version.js';
import type { IdleEngineRuntime } from '../index.js';

export const SIM_REPLAY_FILE_TYPE = 'idle-engine-sim-replay' as const;
export const SIM_REPLAY_SCHEMA_VERSION = 1 as const;

export type SimReplaySchemaVersion = typeof SIM_REPLAY_SCHEMA_VERSION;

export type SimReplayContentDigest = Readonly<{
  readonly version: number | string;
  readonly hash: string;
}>;

export type SimReplayWiringConfig = Readonly<{
  readonly enableProduction: boolean;
  readonly enableAutomation: boolean;
  readonly enableTransforms: boolean;
  readonly enableEntities: boolean;
}>;

export type SimReplayHeaderV1 = Readonly<{
  readonly fileType: typeof SIM_REPLAY_FILE_TYPE;
  readonly schemaVersion: 1;
  readonly recordedAt: number;
  readonly runtimeVersion: string;
}>;

export type SimReplayContentV1 = Readonly<{
  readonly packId: string;
  readonly packVersion: string;
  readonly digest: SimReplayContentDigest;
}>;

export type SimReplayAssetsV1 = Readonly<{
  readonly manifestHash?: string | null;
}>;

export type SimReplaySimV1 = Readonly<{
  readonly wiring: SimReplayWiringConfig;
  readonly stepSizeMs: number;
  readonly startStep: number;
  readonly endStep: number;
  readonly initialSnapshot: GameStateSnapshot;
  readonly commands: readonly Command[];
  readonly endStateChecksum: string;
}>;

export type SimReplayV1 = Readonly<{
  readonly header: SimReplayHeaderV1;
  readonly content: SimReplayContentV1;
  readonly assets: SimReplayAssetsV1;
  readonly sim: SimReplaySimV1;
}>;

type SimReplayRecord =
  | Readonly<{
      readonly type: 'header';
      readonly fileType: typeof SIM_REPLAY_FILE_TYPE;
      readonly schemaVersion: 1;
      readonly recordedAt: number;
      readonly runtimeVersion: string;
    }>
  | Readonly<{
      readonly type: 'content';
      readonly packId: string;
      readonly packVersion: string;
      readonly digest: SimReplayContentDigest;
    }>
  | Readonly<{
      readonly type: 'assets';
      readonly manifestHash?: string | null;
    }>
  | Readonly<{
      readonly type: 'sim';
      readonly wiring: SimReplayWiringConfig;
      readonly stepSizeMs: number;
      readonly startStep: number;
      readonly initialSnapshot: GameStateSnapshot;
    }>
  | Readonly<{
      readonly type: 'commands';
      readonly chunkIndex: number;
      readonly commands: readonly Command[];
    }>
  | Readonly<{
      readonly type: 'end';
      readonly endStep: number;
      readonly endStateChecksum: string;
      readonly commandCount: number;
    }>;

export interface EncodeSimReplayOptions {
  readonly maxCommandsPerChunk?: number;
}

export interface DecodeSimReplayOptions {
  readonly maxCommands?: number;
  readonly maxLines?: number;
}

export interface RunSimReplayOptions {
  readonly content: NormalizedContentPack;
  readonly replay: SimReplayV1;
}

export interface RunSimReplayResult {
  readonly snapshot: GameStateSnapshot;
  readonly checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function readPositiveFiniteNumber(value: unknown, label: string): number {
  const numeric = readFiniteNumber(value, label);
  if (numeric <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return numeric;
}

function readNonNegativeInt(value: unknown, label: string): number {
  const numeric = readFiniteNumber(value, label);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return numeric;
}

function normalizeDigest(value: unknown): SimReplayContentDigest {
  if (!isRecord(value)) {
    throw new Error('content.digest must be an object.');
  }

  const hash = readNonEmptyString(value.hash, 'content.digest.hash');
  const rawVersion = value.version;

  if (typeof rawVersion !== 'number' && typeof rawVersion !== 'string') {
    throw new TypeError('content.digest.version must be a number or string.');
  }

  return Object.freeze({
    version: rawVersion,
    hash,
  });
}

type JsonPrimitive = string | number | boolean | null;

type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

function cloneJsonValue(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  return cloneJsonValueInner(value, seen);
}

function cloneJsonValueInner(
  value: unknown,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
	    case 'number':
	      if (!Number.isFinite(value)) {
	        throw new TypeError('Command payload contains non-finite number.');
	      }
	      return value;
    case 'object':
      break;
    default:
      throw new Error(
        `Command payload contains unsupported JSON type: ${typeof value}`,
      );
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error('Command payload contains a circular reference.');
    }
    seen.add(value);
    const cloned = value.map((entry) => cloneJsonValueInner(entry, seen));
    seen.delete(value);
    return cloned;
  }

	  if (seen.has(value)) {
	    throw new Error('Command payload contains a circular reference.');
	  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('Command payload must be a plain JSON object.');
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('Command payload contains symbol keys.');
  }

	  seen.add(value);
	  const record = value as Record<string, unknown>;
	  const result: Record<string, JsonValue> = {};
	  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined) {
      throw new Error('Command payload contains undefined value.');
    }
    result[key] = cloneJsonValueInner(entry, seen);
  }
	  seen.delete(value);
	  return result;
	}

function normalizeCommand(candidate: unknown): Command {
  if (!isRecord(candidate)) {
    throw new Error('Command must be an object.');
  }

  const type = readNonEmptyString(candidate.type, 'command.type');
  const priorityValue = readFiniteNumber(candidate.priority, 'command.priority');
  const timestamp = readFiniteNumber(candidate.timestamp, 'command.timestamp');
  const step = readNonNegativeInt(candidate.step, 'command.step');

  if (!Object.values(CommandPriority).includes(priorityValue as CommandPriority)) {
    throw new Error('command.priority must be a valid CommandPriority value.');
  }

  const payload = cloneJsonValue(candidate.payload);
  const requestId =
    candidate.requestId === undefined
      ? undefined
      : readNonEmptyString(candidate.requestId, 'command.requestId');

  return Object.freeze({
    type,
    priority: priorityValue as CommandPriority,
    payload,
    timestamp,
    step,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function captureSnapshotFromWiring(
  wiring: GameRuntimeWiring<IdleEngineRuntime>,
  capturedAt?: number,
): GameStateSnapshot {
  return captureGameStateSnapshot({
    runtime: wiring.runtime,
    progressionCoordinator: wiring.coordinator,
    commandQueue: wiring.commandQueue,
    productionSystem: wiring.productionSystem,
    getAutomationState: () => wiring.automationSystem?.getState() ?? new Map(),
    getTransformState: () => wiring.transformSystem?.getState() ?? new Map(),
    getEntityState: () => wiring.entitySystem?.getState() ?? {
      entities: new Map(),
      instances: new Map(),
      entityInstances: new Map(),
    },
    getPrdState: () => wiring.prdRegistry.captureState(),
    ...(capturedAt === undefined ? {} : { capturedAt }),
  });
}

function toWiringConfig(wiring: GameRuntimeWiring): SimReplayWiringConfig {
  return Object.freeze({
    enableProduction: wiring.productionSystem !== undefined,
    enableAutomation: wiring.automationSystem !== undefined,
    enableTransforms: wiring.transformSystem !== undefined,
    enableEntities: wiring.entitySystem !== undefined,
  });
}

export class SimReplayRecorder {
  private readonly content: NormalizedContentPack;
  private readonly wiring: GameRuntimeWiring<IdleEngineRuntime>;
  private readonly wiringConfig: SimReplayWiringConfig;
  private readonly recordedAt: number;
  private readonly startSnapshot: GameStateSnapshot;
  private readonly commands: Command[] = [];

  constructor(options: {
    readonly content: NormalizedContentPack;
    readonly wiring: GameRuntimeWiring<IdleEngineRuntime>;
    readonly recordedAt?: number;
    readonly capturedAt?: number;
  }) {
    this.content = options.content;
    this.wiring = options.wiring;
    this.wiringConfig = toWiringConfig(options.wiring);
    this.recordedAt = options.recordedAt ?? Date.now();
    this.startSnapshot = captureSnapshotFromWiring(
      options.wiring,
      options.capturedAt,
    );
  }

  recordCommand(command: Command): void {
    this.commands.push(normalizeCommand(command));
  }

  export(options?: { readonly capturedAt?: number }): SimReplayV1 {
    const endSnapshot = captureSnapshotFromWiring(
      this.wiring,
      options?.capturedAt,
    );
    const endStateChecksum = computeStateChecksum(endSnapshot);

    const digest = normalizeDigest(this.content.digest as unknown);

    return Object.freeze({
      header: {
        fileType: SIM_REPLAY_FILE_TYPE,
        schemaVersion: SIM_REPLAY_SCHEMA_VERSION,
        recordedAt: this.recordedAt,
        runtimeVersion: RUNTIME_VERSION,
      },
      content: {
        packId: this.content.metadata.id,
        packVersion: this.content.metadata.version,
        digest,
      },
      assets: {
        manifestHash: null,
      },
      sim: {
        wiring: this.wiringConfig,
        stepSizeMs: this.startSnapshot.runtime.stepSizeMs,
        startStep: this.startSnapshot.runtime.step,
        endStep: endSnapshot.runtime.step,
        initialSnapshot: this.startSnapshot,
        commands: Object.freeze([...this.commands]),
        endStateChecksum,
      },
    });
  }
}

function assertReplayMatchesContentDigest(
  replay: SimReplayV1,
  content: NormalizedContentPack,
): void {
  const expectedDigest = normalizeDigest(content.digest as unknown);
  const actual = replay.content.digest;

  if (
    actual.hash !== expectedDigest.hash ||
    String(actual.version) !== String(expectedDigest.version)
  ) {
    telemetry.recordError('SimReplayContentDigestMismatch', {
      expected: expectedDigest,
      received: actual,
      packId: replay.content.packId,
      packVersion: replay.content.packVersion,
    });
    throw new Error('Content digest mismatch. Replay is not compatible with the provided content pack.');
  }
}

function assertReplaySimSnapshotIsSupported(replay: SimReplayV1): GameStateSnapshot {
  const snapshot = replay.sim.initialSnapshot;
  if (snapshot.version !== 1) {
    throw new Error('Replay snapshot version is not supported.');
  }

  if (!Number.isInteger(replay.sim.startStep) || replay.sim.startStep < 0) {
    throw new Error('Replay startStep must be a non-negative integer.');
  }

  if (!Number.isInteger(replay.sim.endStep) || replay.sim.endStep < 0) {
    throw new Error('Replay endStep must be a non-negative integer.');
  }

  if (!Number.isFinite(replay.sim.stepSizeMs) || replay.sim.stepSizeMs <= 0) {
    throw new Error('Replay stepSizeMs must be a positive, finite number.');
  }

  if (replay.sim.startStep !== snapshot.runtime.step) {
    throw new Error('Replay startStep does not match the initial snapshot.');
  }

  if (replay.sim.stepSizeMs !== snapshot.runtime.stepSizeMs) {
    throw new Error('Replay stepSizeMs does not match the initial snapshot.');
  }

  return snapshot;
}

function assertRestoredRuntimeMatchesReplay(
  replay: SimReplayV1,
  wiring: GameRuntimeWiring<IdleEngineRuntime>,
): Readonly<{ startStep: number; stepSizeMs: number }> {
  const endStep = replay.sim.endStep;
  const startStep = wiring.runtime.getCurrentStep();

  if (endStep < startStep) {
    throw new Error('Replay endStep must be greater than or equal to the restored runtime step.');
  }

  if (replay.sim.startStep !== startStep) {
    throw new Error('Replay startStep does not match the restored runtime step.');
  }

  const stepSizeMs = wiring.runtime.getStepSizeMs();
  if (stepSizeMs !== replay.sim.stepSizeMs) {
    throw new Error('Replay stepSizeMs does not match the restored runtime step size.');
  }

  return { startStep, stepSizeMs };
}

function scheduleReplayCommands(
  commands: readonly Command[],
  startStep: number,
  endStep: number,
): Readonly<{ commandsByStep: Map<number, Command[]>; postSimCommands: Command[] }> {
  const commandsByStep = new Map<number, Command[]>();
  const postSimCommands: Command[] = [];

  for (const command of commands) {
    if (command.step < startStep) {
      throw new Error('Replay command step must be greater than or equal to the replay startStep.');
    }

    if (command.step >= endStep) {
      postSimCommands.push(command);
      continue;
    }

    const bucket = commandsByStep.get(command.step);
    if (bucket) {
      bucket.push(command);
      continue;
    }
    commandsByStep.set(command.step, [command]);
  }

  return { commandsByStep, postSimCommands };
}

function enqueueRecordedCommands(
  wiring: GameRuntimeWiring<IdleEngineRuntime>,
  commands: readonly Command[],
  contextStep: number | null,
): void {
  for (const command of commands) {
    const accepted = wiring.commandQueue.enqueue(command);
    if (accepted) {
      continue;
    }
    telemetry.recordError('SimReplayCommandRejected', {
      type: command.type,
      priority: command.priority,
      timestamp: command.timestamp,
      step: command.step,
      runtimeStep: wiring.runtime.getCurrentStep(),
      ...(contextStep === null ? {} : { contextStep }),
    });
    throw new Error('Replay command rejected by command queue.');
  }
}

function runReplaySimulation(options: {
  readonly wiring: GameRuntimeWiring<IdleEngineRuntime>;
  readonly endStep: number;
  readonly stepSizeMs: number;
  readonly commandsByStep: Map<number, Command[]>;
  readonly postSimCommands: readonly Command[];
}): void {
  const { wiring, endStep, stepSizeMs, commandsByStep, postSimCommands } = options;

  while (wiring.runtime.getCurrentStep() < endStep) {
    const currentStep = wiring.runtime.getCurrentStep();
    const stepCommands = commandsByStep.get(currentStep);
    if (stepCommands) {
      enqueueRecordedCommands(wiring, stepCommands, currentStep);
      commandsByStep.delete(currentStep);
    }
    wiring.runtime.tick(stepSizeMs);
  }

  if (postSimCommands.length > 0) {
    enqueueRecordedCommands(wiring, postSimCommands, null);
  }
}

function captureReplayResultAndValidateChecksum(
  replay: SimReplayV1,
  wiring: GameRuntimeWiring<IdleEngineRuntime>,
): RunSimReplayResult {
  const endSnapshot = captureSnapshotFromWiring(wiring);
  const checksum = computeStateChecksum(endSnapshot);

  if (checksum !== replay.sim.endStateChecksum) {
    telemetry.recordError('SimReplayChecksumMismatch', {
      expected: replay.sim.endStateChecksum,
      received: checksum,
      endStep: endSnapshot.runtime.step,
    });
    throw new Error('Replay end-state checksum mismatch.');
  }

  return { snapshot: endSnapshot, checksum };
}

export function runSimReplay(options: RunSimReplayOptions): RunSimReplayResult {
  const { content, replay } = options;

  assertReplayMatchesContentDigest(replay, content);
  const snapshot = assertReplaySimSnapshotIsSupported(replay);

  const wiring = restoreGameRuntimeFromSnapshot({
    content,
    snapshot,
    enableProduction: replay.sim.wiring.enableProduction,
    enableAutomation: replay.sim.wiring.enableAutomation,
    enableTransforms: replay.sim.wiring.enableTransforms,
    enableEntities: replay.sim.wiring.enableEntities,
    runtimeOptions: {
      maxStepsPerFrame: 1,
    },
  }) as GameRuntimeWiring<IdleEngineRuntime>;

  const endStep = replay.sim.endStep;
  const { startStep, stepSizeMs } = assertRestoredRuntimeMatchesReplay(replay, wiring);
  const { commandsByStep, postSimCommands } = scheduleReplayCommands(
    replay.sim.commands,
    startStep,
    endStep,
  );

  runReplaySimulation({
    wiring,
    endStep,
    stepSizeMs,
    commandsByStep,
    postSimCommands,
  });

  return captureReplayResultAndValidateChecksum(replay, wiring);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

export function encodeSimReplayJsonLines(
  replay: SimReplayV1,
  options: EncodeSimReplayOptions = {},
): string {
  const maxCommandsPerChunk = options.maxCommandsPerChunk ?? 1000;
  assertPositiveInteger(maxCommandsPerChunk, 'maxCommandsPerChunk');

  const records: SimReplayRecord[] = [
    {
      type: 'header',
      ...replay.header,
    },
    {
      type: 'content',
      ...replay.content,
    },
    {
      type: 'assets',
      ...replay.assets,
    },
    {
      type: 'sim',
      wiring: replay.sim.wiring,
      stepSizeMs: replay.sim.stepSizeMs,
      startStep: replay.sim.startStep,
      initialSnapshot: replay.sim.initialSnapshot,
    },
  ];

  const commands = replay.sim.commands;
  let chunkIndex = 0;
  for (let i = 0; i < commands.length; i += maxCommandsPerChunk) {
    records.push({
      type: 'commands',
      chunkIndex,
      commands: commands.slice(i, i + maxCommandsPerChunk),
    });
    chunkIndex += 1;
  }

  records.push({
    type: 'end',
    endStep: replay.sim.endStep,
    endStateChecksum: replay.sim.endStateChecksum,
    commandCount: commands.length,
  });

  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

const DEFAULT_MAX_SIM_REPLAY_COMMANDS = 1_000_000;
const DEFAULT_MAX_SIM_REPLAY_LINES = 2_000_000;

function splitReplayLines(input: string, maxLines: number): readonly string[] {
  const lines = input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('Replay input is empty.');
  }

  if (lines.length > maxLines) {
    throw new Error('Replay input exceeds configured line limit.');
  }

  return lines;
}

function readSimReplayRecord(line: string): SimReplayRecord {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Replay record must be an object.');
  }
  const type = readNonEmptyString(parsed.type, 'record.type');
  return { ...parsed, type } as SimReplayRecord;
}

function readRequiredSimReplayRecord<TType extends SimReplayRecord['type']>(
  lines: readonly string[],
  index: number,
  expectedType: TType,
  errorMessage: string,
): Extract<SimReplayRecord, { type: TType }> {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(errorMessage);
  }

  const record = readSimReplayRecord(line);
  if (record.type !== expectedType) {
    throw new Error(errorMessage);
  }

  return record as Extract<SimReplayRecord, { type: TType }>;
}

function normalizeReplayWiringConfig(value: unknown): SimReplayWiringConfig {
  if (!isRecord(value)) {
    throw new Error('sim.wiring must be an object.');
  }

  return Object.freeze({
    enableProduction: Boolean(value.enableProduction),
    enableAutomation: Boolean(value.enableAutomation),
    enableTransforms: Boolean(value.enableTransforms),
    enableEntities: Boolean(value.enableEntities),
  });
}

function readReplayInitialSnapshot(value: unknown): GameStateSnapshot {
  if (!isRecord(value)) {
    throw new Error('sim.initialSnapshot must be an object.');
  }
  return value as unknown as GameStateSnapshot;
}

function appendReplayCommandChunk(options: {
  readonly commands: Command[];
  readonly chunk: unknown;
  readonly maxCommands: number;
}): void {
  const { commands, chunk, maxCommands } = options;
  if (!Array.isArray(chunk)) {
    throw new TypeError('Replay command chunk must contain commands array.');
  }

  for (const command of chunk) {
    commands.push(normalizeCommand(command));
    if (commands.length > maxCommands) {
      throw new Error('Replay command stream exceeds configured command limit.');
    }
  }
}

function parseReplayEndRecord(record: Extract<SimReplayRecord, { type: 'end' }>): Readonly<{
  readonly endStep: number;
  readonly endStateChecksum: string;
  readonly expectedCommandCount: number;
}> {
  return Object.freeze({
    endStep: readNonNegativeInt(record.endStep, 'end.endStep'),
    endStateChecksum: readNonEmptyString(record.endStateChecksum, 'end.endStateChecksum'),
    expectedCommandCount: readNonNegativeInt(record.commandCount, 'end.commandCount'),
  });
}

function readReplayCommandsAndEndRecord(options: {
  readonly lines: readonly string[];
  readonly startIndex: number;
  readonly maxCommands: number;
}): Readonly<{
  readonly commands: readonly Command[];
  readonly endStep: number;
  readonly endStateChecksum: string;
}> {
  const { lines, startIndex, maxCommands } = options;

  const commands: Command[] = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    const record = readSimReplayRecord(lines[index] ?? '');
    if (record.type === 'commands') {
      appendReplayCommandChunk({ commands, chunk: record.commands, maxCommands });
      continue;
    }

    if (record.type === 'end') {
      const { endStep, endStateChecksum, expectedCommandCount } = parseReplayEndRecord(record);
      if (expectedCommandCount !== commands.length) {
        throw new Error('Replay command count does not match footer.');
      }
      return { commands: Object.freeze(commands), endStep, endStateChecksum };
    }

    throw new Error(`Unexpected replay record type: ${record.type}`);
  }

  throw new Error('Replay is missing end record.');
}

export function decodeSimReplayJsonLines(
  input: string,
  options: DecodeSimReplayOptions = {},
): SimReplayV1 {
  if (typeof input !== 'string') {
    throw new TypeError('Replay input must be a string.');
  }

  const maxCommands = options.maxCommands ?? DEFAULT_MAX_SIM_REPLAY_COMMANDS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_SIM_REPLAY_LINES;

  assertPositiveInteger(maxCommands, 'maxCommands');
  assertPositiveInteger(maxLines, 'maxLines');

  const lines = splitReplayLines(input, maxLines);

  const headerRecord = readRequiredSimReplayRecord(
    lines,
    0,
    'header',
    'Replay header record must appear first.',
  );
  if (headerRecord.fileType !== SIM_REPLAY_FILE_TYPE) {
    throw new Error('Replay fileType is not supported.');
  }
  if (headerRecord.schemaVersion !== SIM_REPLAY_SCHEMA_VERSION) {
    throw new Error('Replay schemaVersion is not supported.');
  }

  const contentRecord = readRequiredSimReplayRecord(
    lines,
    1,
    'content',
    'Replay content record must appear second.',
  );

  const assetsRecord = readRequiredSimReplayRecord(
    lines,
    2,
    'assets',
    'Replay assets record must appear third.',
  );

  const simRecord = readRequiredSimReplayRecord(
    lines,
    3,
    'sim',
    'Replay sim record must appear fourth.',
  );

  const { commands, endStep, endStateChecksum } = readReplayCommandsAndEndRecord({
    lines,
    startIndex: 4,
    maxCommands,
  });

  const wiring = normalizeReplayWiringConfig(simRecord.wiring);
  const startSnapshot = readReplayInitialSnapshot(simRecord.initialSnapshot);

  const stepSizeMs = readPositiveFiniteNumber(simRecord.stepSizeMs, 'sim.stepSizeMs');
  const startStep = readNonNegativeInt(simRecord.startStep, 'sim.startStep');

  const packId = readNonEmptyString(contentRecord.packId, 'content.packId');
  const packVersion = readNonEmptyString(contentRecord.packVersion, 'content.packVersion');
  const digest = normalizeDigest(contentRecord.digest);

  const recordedAt = readFiniteNumber(headerRecord.recordedAt, 'header.recordedAt');
  const runtimeVersion = readNonEmptyString(headerRecord.runtimeVersion, 'header.runtimeVersion');

  return Object.freeze({
    header: {
      fileType: SIM_REPLAY_FILE_TYPE,
      schemaVersion: SIM_REPLAY_SCHEMA_VERSION,
      recordedAt,
      runtimeVersion,
    },
    content: {
      packId,
      packVersion,
      digest,
    },
    assets: {
      manifestHash:
        assetsRecord.manifestHash === undefined || assetsRecord.manifestHash === null
          ? null
          : readNonEmptyString(assetsRecord.manifestHash, 'assets.manifestHash'),
    },
    sim: {
      wiring,
      stepSizeMs,
      startStep,
	      endStep,
	      initialSnapshot: startSnapshot,
	      commands,
	      endStateChecksum,
	    },
	  });
}
