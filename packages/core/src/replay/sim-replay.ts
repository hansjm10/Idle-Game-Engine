import type { NormalizedContentPack } from '@idle-engine/content-schema';
import {
  hashRenderCommandBuffer,
  hashViewModel,
} from '@idle-engine/renderer-contract';
import type {
  RenderCommandBuffer,
  ViewModel,
} from '@idle-engine/renderer-contract';

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
export const SIM_REPLAY_SCHEMA_VERSION = 2 as const;

export type SimReplaySchemaVersion = 1 | 2;

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

export type SimReplayHeaderV2 = Readonly<{
  readonly fileType: typeof SIM_REPLAY_FILE_TYPE;
  readonly schemaVersion: 2;
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

export type SimReplayViewModelFrameV2 = Readonly<{
  readonly step: number;
  readonly hash: string;
  readonly viewModel: ViewModel;
}>;

export type SimReplayRenderCommandBufferFrameV2 = Readonly<{
  readonly renderFrame: number;
  readonly step: number;
  readonly hash: string;
  readonly rcb: RenderCommandBuffer;
}>;

export type SimReplayFramesV2 = Readonly<{
  readonly viewModels: readonly SimReplayViewModelFrameV2[];
  readonly rcbs: readonly SimReplayRenderCommandBufferFrameV2[];
}>;

export type SimReplayV1 = Readonly<{
  readonly header: SimReplayHeaderV1;
  readonly content: SimReplayContentV1;
  readonly assets: SimReplayAssetsV1;
  readonly sim: SimReplaySimV1;
}>;

export type SimReplayV2 = Readonly<{
  readonly header: SimReplayHeaderV2;
  readonly content: SimReplayContentV1;
  readonly assets: SimReplayAssetsV1;
  readonly sim: SimReplaySimV1;
  readonly frames?: SimReplayFramesV2 | null;
}>;

export type SimReplay = SimReplayV1 | SimReplayV2;

type SimReplayRecord =
  | Readonly<{
      readonly type: 'header';
      readonly fileType: typeof SIM_REPLAY_FILE_TYPE;
      readonly schemaVersion: SimReplaySchemaVersion;
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
      readonly type: 'viewModelFrames';
      readonly chunkIndex: number;
      readonly frames: readonly SimReplayViewModelFrameV2[];
    }>
  | Readonly<{
      readonly type: 'rcbFrames';
      readonly chunkIndex: number;
      readonly frames: readonly SimReplayRenderCommandBufferFrameV2[];
    }>
  | Readonly<{
      readonly type: 'end';
      readonly endStep: number;
      readonly endStateChecksum: string;
      readonly commandCount: number;
      readonly viewModelFrameCount?: number;
      readonly rcbFrameCount?: number;
    }>;

export interface EncodeSimReplayOptions {
  readonly maxCommandsPerChunk?: number;
  readonly maxViewModelFramesPerChunk?: number;
  readonly maxRcbFramesPerChunk?: number;
}

export interface DecodeSimReplayOptions {
  readonly maxCommands?: number;
  readonly maxLines?: number;
  readonly maxViewModelFrames?: number;
  readonly maxRcbFrames?: number;
}

export interface RunSimReplayOptions {
  readonly content: NormalizedContentPack;
  readonly replay: SimReplay;
}

export interface RunSimReplayResult {
  readonly snapshot: GameStateSnapshot;
  readonly checksum: string;
}

export type VisualReplayMismatchSummary = Readonly<{
  readonly event: 'visual_replay_mismatch';
  readonly schemaVersion: 1;
  readonly stream: 'viewModel' | 'rcb';
  readonly step: number;
  readonly renderFrame?: number;
  readonly expectedHash: string;
  readonly actualHash: string;
}>;

export class VisualReplayMismatchError extends Error {
  readonly summary: VisualReplayMismatchSummary;

  constructor(summary: VisualReplayMismatchSummary) {
    super(`Visual replay hash mismatch\n${JSON.stringify(summary)}\n`);
    this.name = 'VisualReplayMismatchError';
    this.summary = summary;
  }
}

export interface RunCombinedReplayOptions {
  readonly content: NormalizedContentPack;
  readonly replay: SimReplay;
  readonly buildViewModel?: (options: {
    readonly wiring: GameRuntimeWiring<IdleEngineRuntime>;
    readonly step: number;
    readonly simTimeMs: number;
  }) => ViewModel | Promise<ViewModel>;
  readonly buildRenderCommandBuffers?: (options: {
    readonly wiring: GameRuntimeWiring<IdleEngineRuntime>;
    readonly step: number;
    readonly simTimeMs: number;
    readonly viewModel?: ViewModel;
  }) => readonly RenderCommandBuffer[] | Promise<readonly RenderCommandBuffer[]>;
}

export interface RunCombinedReplayResult extends RunSimReplayResult {
  readonly viewModelFramesValidated: number;
  readonly rcbFramesValidated: number;
}

function isSimReplayV2(replay: SimReplay): replay is SimReplayV2 {
  return replay.header.schemaVersion === 2;
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

  export(options?: { readonly capturedAt?: number }): SimReplayV2 {
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
  replay: SimReplay,
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

function assertReplaySimSnapshotIsSupported(replay: SimReplay): GameStateSnapshot {
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
  replay: SimReplay,
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
  replay: SimReplay,
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

function throwVisualReplayMismatch(summary: VisualReplayMismatchSummary): never {
  telemetry.recordError('VisualReplayHashMismatch', summary);
  throw new VisualReplayMismatchError(summary);
}

export async function runCombinedReplay(
  options: RunCombinedReplayOptions,
): Promise<RunCombinedReplayResult> {
  const { content, replay } = options;

  const viewModelFrames = isSimReplayV2(replay)
    ? replay.frames?.viewModels ?? []
    : [];
  const rcbFrames = isSimReplayV2(replay) ? replay.frames?.rcbs ?? [] : [];

  if (viewModelFrames.length > 0 && options.buildViewModel === undefined) {
    throw new Error('Replay contains ViewModel frames but buildViewModel was not provided.');
  }

  if (rcbFrames.length > 0 && options.buildRenderCommandBuffers === undefined) {
    throw new Error(
      'Replay contains RenderCommandBuffer frames but buildRenderCommandBuffers was not provided.',
    );
  }

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
  const { startStep, stepSizeMs } = assertRestoredRuntimeMatchesReplay(
    replay,
    wiring,
  );
  const { commandsByStep, postSimCommands } = scheduleReplayCommands(
    replay.sim.commands,
    startStep,
    endStep,
  );

  let viewModelCursor = 0;
  let rcbCursor = 0;

  while (wiring.runtime.getCurrentStep() < endStep) {
    const currentStep = wiring.runtime.getCurrentStep();
    const stepCommands = commandsByStep.get(currentStep);
    if (stepCommands) {
      enqueueRecordedCommands(wiring, stepCommands, currentStep);
      commandsByStep.delete(currentStep);
    }

    wiring.runtime.tick(stepSizeMs);

    const processedStep = wiring.runtime.getCurrentStep() - 1;
    const simTimeMs = processedStep * stepSizeMs;

    let viewModel: ViewModel | undefined;

    if (viewModelFrames.length > 0) {
      const expected = viewModelFrames[viewModelCursor];
      if (!expected) {
        telemetry.recordError('VisualReplayMissingViewModelFrame', {
          step: processedStep,
          expected: viewModelFrames.length,
          consumed: viewModelCursor,
        });
        throw new Error('Replay is missing recorded ViewModel frames.');
      }

      if (expected.step !== processedStep) {
        telemetry.recordError('VisualReplayViewModelFrameMisaligned', {
          expectedStep: expected.step,
          actualStep: processedStep,
        });
        throw new Error('Replay ViewModel frame step mismatch.');
      }

      viewModel = await options.buildViewModel!({
        wiring,
        step: processedStep,
        simTimeMs,
      });

      const actualHash = await hashViewModel(viewModel);
      if (actualHash !== expected.hash) {
        throwVisualReplayMismatch({
          event: 'visual_replay_mismatch',
          schemaVersion: 1,
          stream: 'viewModel',
          step: processedStep,
          expectedHash: expected.hash,
          actualHash,
        });
      }

      viewModelCursor += 1;
    }

    if (rcbFrames.length > 0) {
      const produced = await options.buildRenderCommandBuffers!({
        wiring,
        step: processedStep,
        simTimeMs,
        ...(viewModel === undefined ? {} : { viewModel }),
      });

      if (!Array.isArray(produced)) {
        throw new TypeError('buildRenderCommandBuffers must return an array.');
      }

      for (const rcb of produced) {
        const expected = rcbFrames[rcbCursor];
        if (!expected) {
          telemetry.recordError('VisualReplayUnexpectedRcbFrame', {
            step: processedStep,
            expected: rcbFrames.length,
            consumed: rcbCursor,
          });
          throw new Error('Replay produced more RenderCommandBuffer frames than were recorded.');
        }

        const actualRenderFrame = rcb.frame.renderFrame;
        if (
          typeof actualRenderFrame !== 'number' ||
          !Number.isInteger(actualRenderFrame) ||
          actualRenderFrame < 0
        ) {
          throw new Error('RenderCommandBuffer.frame.renderFrame must be a non-negative integer.');
        }

        if (actualRenderFrame !== expected.renderFrame || rcb.frame.step !== expected.step) {
          telemetry.recordError('VisualReplayRcbFrameMisaligned', {
            expectedRenderFrame: expected.renderFrame,
            actualRenderFrame,
            expectedStep: expected.step,
            actualStep: rcb.frame.step,
          });
          throw new Error('Replay RenderCommandBuffer frame alignment mismatch.');
        }

        const actualHash = await hashRenderCommandBuffer(rcb);
        if (actualHash !== expected.hash) {
          throwVisualReplayMismatch({
            event: 'visual_replay_mismatch',
            schemaVersion: 1,
            stream: 'rcb',
            step: expected.step,
            renderFrame: expected.renderFrame,
            expectedHash: expected.hash,
            actualHash,
          });
        }

        rcbCursor += 1;
      }
    }
  }

  if (postSimCommands.length > 0) {
    enqueueRecordedCommands(wiring, postSimCommands, null);
  }

  if (viewModelCursor !== viewModelFrames.length) {
    telemetry.recordError('VisualReplayMissingViewModelFrames', {
      expected: viewModelFrames.length,
      consumed: viewModelCursor,
    });
    throw new Error('Replay did not validate all recorded ViewModel frames.');
  }

  if (rcbCursor !== rcbFrames.length) {
    telemetry.recordError('VisualReplayMissingRcbFrames', {
      expected: rcbFrames.length,
      consumed: rcbCursor,
    });
    throw new Error('Replay did not validate all recorded RenderCommandBuffer frames.');
  }

  const simResult = captureReplayResultAndValidateChecksum(replay, wiring);

  return {
    ...simResult,
    viewModelFramesValidated: viewModelCursor,
    rcbFramesValidated: rcbCursor,
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

export function encodeSimReplayJsonLines(
  replay: SimReplay,
  options: EncodeSimReplayOptions = {},
): string {
  const maxCommandsPerChunk = options.maxCommandsPerChunk ?? 1000;
  const maxViewModelFramesPerChunk = options.maxViewModelFramesPerChunk ?? 250;
  const maxRcbFramesPerChunk = options.maxRcbFramesPerChunk ?? 250;
  assertPositiveInteger(maxCommandsPerChunk, 'maxCommandsPerChunk');
  assertPositiveInteger(maxViewModelFramesPerChunk, 'maxViewModelFramesPerChunk');
  assertPositiveInteger(maxRcbFramesPerChunk, 'maxRcbFramesPerChunk');

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

  const viewModelFrames = isSimReplayV2(replay)
    ? replay.frames?.viewModels ?? []
    : [];
  const rcbFrames = isSimReplayV2(replay) ? replay.frames?.rcbs ?? [] : [];

  if (
    replay.header.schemaVersion === 1 &&
    (viewModelFrames.length > 0 || rcbFrames.length > 0)
  ) {
    throw new Error('Replay schemaVersion 1 does not support visual frames.');
  }

  let viewModelChunkIndex = 0;
  for (let i = 0; i < viewModelFrames.length; i += maxViewModelFramesPerChunk) {
    records.push({
      type: 'viewModelFrames',
      chunkIndex: viewModelChunkIndex,
      frames: viewModelFrames.slice(i, i + maxViewModelFramesPerChunk),
    });
    viewModelChunkIndex += 1;
  }

  let rcbChunkIndex = 0;
  for (let i = 0; i < rcbFrames.length; i += maxRcbFramesPerChunk) {
    records.push({
      type: 'rcbFrames',
      chunkIndex: rcbChunkIndex,
      frames: rcbFrames.slice(i, i + maxRcbFramesPerChunk),
    });
    rcbChunkIndex += 1;
  }

  records.push({
    type: 'end',
    endStep: replay.sim.endStep,
    endStateChecksum: replay.sim.endStateChecksum,
    commandCount: commands.length,
    ...(replay.header.schemaVersion === 2
      ? {
          viewModelFrameCount: viewModelFrames.length,
          rcbFrameCount: rcbFrames.length,
        }
      : {}),
  });

  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

const DEFAULT_MAX_SIM_REPLAY_COMMANDS = 1_000_000;
const DEFAULT_MAX_SIM_REPLAY_LINES = 2_000_000;
const DEFAULT_MAX_SIM_REPLAY_VIEW_MODEL_FRAMES = 100_000;
const DEFAULT_MAX_SIM_REPLAY_RCB_FRAMES = 100_000;

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

function parseReplayEndRecord(
  record: Extract<SimReplayRecord, { type: 'end' }>,
  schemaVersion: SimReplaySchemaVersion,
): Readonly<{
  readonly endStep: number;
  readonly endStateChecksum: string;
  readonly expectedCommandCount: number;
  readonly expectedViewModelFrameCount: number;
  readonly expectedRcbFrameCount: number;
}> {
  const expectedViewModelFrameCount =
    schemaVersion === 2
      ? readNonNegativeInt(record.viewModelFrameCount, 'end.viewModelFrameCount')
      : 0;

  const expectedRcbFrameCount =
    schemaVersion === 2
      ? readNonNegativeInt(record.rcbFrameCount, 'end.rcbFrameCount')
      : 0;

  return Object.freeze({
    endStep: readNonNegativeInt(record.endStep, 'end.endStep'),
    endStateChecksum: readNonEmptyString(record.endStateChecksum, 'end.endStateChecksum'),
    expectedCommandCount: readNonNegativeInt(record.commandCount, 'end.commandCount'),
    expectedViewModelFrameCount,
    expectedRcbFrameCount,
  });
}

function normalizeViewModelFrame(candidate: unknown): SimReplayViewModelFrameV2 {
  if (!isRecord(candidate)) {
    throw new Error('ViewModel frame must be an object.');
  }

  const step = readNonNegativeInt(candidate.step, 'viewModelFrame.step');
  const hash = readNonEmptyString(candidate.hash, 'viewModelFrame.hash');

  const viewModelCandidate = cloneJsonValue(candidate.viewModel) as unknown;
  if (!isRecord(viewModelCandidate)) {
    throw new Error('viewModelFrame.viewModel must be an object.');
  }

  const headerCandidate = viewModelCandidate.frame;
  if (!isRecord(headerCandidate)) {
    throw new Error('viewModelFrame.viewModel.frame must be an object.');
  }

  const payloadStep = readNonNegativeInt(headerCandidate.step, 'viewModelFrame.viewModel.frame.step');
  if (payloadStep !== step) {
    throw new Error('viewModelFrame.step does not match viewModel.frame.step.');
  }

  return Object.freeze({
    step,
    hash,
    viewModel: viewModelCandidate as unknown as ViewModel,
  });
}

function normalizeRcbFrame(candidate: unknown): SimReplayRenderCommandBufferFrameV2 {
  if (!isRecord(candidate)) {
    throw new Error('RenderCommandBuffer frame must be an object.');
  }

  const renderFrame = readNonNegativeInt(candidate.renderFrame, 'rcbFrame.renderFrame');
  const step = readNonNegativeInt(candidate.step, 'rcbFrame.step');
  const hash = readNonEmptyString(candidate.hash, 'rcbFrame.hash');

  const rcbCandidate = cloneJsonValue(candidate.rcb) as unknown;
  if (!isRecord(rcbCandidate)) {
    throw new Error('rcbFrame.rcb must be an object.');
  }

  const headerCandidate = rcbCandidate.frame;
  if (!isRecord(headerCandidate)) {
    throw new Error('rcbFrame.rcb.frame must be an object.');
  }

  const payloadStep = readNonNegativeInt(headerCandidate.step, 'rcbFrame.rcb.frame.step');
  if (payloadStep !== step) {
    throw new Error('rcbFrame.step does not match rcb.frame.step.');
  }

  const payloadRenderFrame = headerCandidate.renderFrame;
  if (!Number.isInteger(payloadRenderFrame) || payloadRenderFrame !== renderFrame) {
    throw new Error('rcbFrame.renderFrame does not match rcb.frame.renderFrame.');
  }

  return Object.freeze({
    renderFrame,
    step,
    hash,
    rcb: rcbCandidate as unknown as RenderCommandBuffer,
  });
}

function readReplayBodyAndEndRecord(options: {
  readonly lines: readonly string[];
  readonly startIndex: number;
  readonly schemaVersion: SimReplaySchemaVersion;
  readonly maxCommands: number;
  readonly maxViewModelFrames: number;
  readonly maxRcbFrames: number;
}): Readonly<{
  readonly commands: readonly Command[];
  readonly viewModelFrames: readonly SimReplayViewModelFrameV2[];
  readonly rcbFrames: readonly SimReplayRenderCommandBufferFrameV2[];
  readonly endStep: number;
  readonly endStateChecksum: string;
}> {
  const {
    lines,
    startIndex,
    schemaVersion,
    maxCommands,
    maxViewModelFrames,
    maxRcbFrames,
  } = options;

  const commands: Command[] = [];
  const viewModelFrames: SimReplayViewModelFrameV2[] = [];
  const rcbFrames: SimReplayRenderCommandBufferFrameV2[] = [];

  let lastViewModelStep = -1;
  let lastRcbRenderFrame = -1;

  for (let index = startIndex; index < lines.length; index += 1) {
    const record = readSimReplayRecord(lines[index] ?? '');
    if (record.type === 'commands') {
      appendReplayCommandChunk({ commands, chunk: record.commands, maxCommands });
      continue;
    }

    if (record.type === 'viewModelFrames') {
      if (schemaVersion !== 2) {
        throw new Error('Replay schemaVersion does not support viewModelFrames records.');
      }
      if (!Array.isArray(record.frames)) {
        throw new TypeError('Replay viewModelFrames record must contain frames array.');
      }

      for (const frameCandidate of record.frames) {
        const frame = normalizeViewModelFrame(frameCandidate);
        if (frame.step <= lastViewModelStep) {
          throw new Error('Replay ViewModel frames must be sorted by step.');
        }
        lastViewModelStep = frame.step;
        viewModelFrames.push(frame);
        if (viewModelFrames.length > maxViewModelFrames) {
          throw new Error('Replay ViewModel frame stream exceeds configured frame limit.');
        }
      }

      continue;
    }

    if (record.type === 'rcbFrames') {
      if (schemaVersion !== 2) {
        throw new Error('Replay schemaVersion does not support rcbFrames records.');
      }
      if (!Array.isArray(record.frames)) {
        throw new TypeError('Replay rcbFrames record must contain frames array.');
      }

      for (const frameCandidate of record.frames) {
        const frame = normalizeRcbFrame(frameCandidate);
        if (frame.renderFrame <= lastRcbRenderFrame) {
          throw new Error('Replay RenderCommandBuffer frames must be sorted by renderFrame.');
        }
        lastRcbRenderFrame = frame.renderFrame;
        rcbFrames.push(frame);
        if (rcbFrames.length > maxRcbFrames) {
          throw new Error('Replay RenderCommandBuffer frame stream exceeds configured frame limit.');
        }
      }

      continue;
    }

    if (record.type === 'end') {
      const {
        endStep,
        endStateChecksum,
        expectedCommandCount,
        expectedViewModelFrameCount,
        expectedRcbFrameCount,
      } = parseReplayEndRecord(record, schemaVersion);
      if (expectedCommandCount !== commands.length) {
        throw new Error('Replay command count does not match footer.');
      }

      if (schemaVersion === 2) {
        if (expectedViewModelFrameCount !== viewModelFrames.length) {
          throw new Error('Replay ViewModel frame count does not match footer.');
        }
        if (expectedRcbFrameCount !== rcbFrames.length) {
          throw new Error('Replay RenderCommandBuffer frame count does not match footer.');
        }
      }

      return {
        commands: Object.freeze(commands),
        viewModelFrames: Object.freeze(viewModelFrames),
        rcbFrames: Object.freeze(rcbFrames),
        endStep,
        endStateChecksum,
      };
    }

    throw new Error(`Unexpected replay record type: ${record.type}`);
  }

  throw new Error('Replay is missing end record.');
}

export function decodeSimReplayJsonLines(
  input: string,
  options: DecodeSimReplayOptions = {},
): SimReplay {
  if (typeof input !== 'string') {
    throw new TypeError('Replay input must be a string.');
  }

  const maxCommands = options.maxCommands ?? DEFAULT_MAX_SIM_REPLAY_COMMANDS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_SIM_REPLAY_LINES;
  const maxViewModelFrames =
    options.maxViewModelFrames ?? DEFAULT_MAX_SIM_REPLAY_VIEW_MODEL_FRAMES;
  const maxRcbFrames = options.maxRcbFrames ?? DEFAULT_MAX_SIM_REPLAY_RCB_FRAMES;

  assertPositiveInteger(maxCommands, 'maxCommands');
  assertPositiveInteger(maxLines, 'maxLines');
  assertPositiveInteger(maxViewModelFrames, 'maxViewModelFrames');
  assertPositiveInteger(maxRcbFrames, 'maxRcbFrames');

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

  if (headerRecord.schemaVersion !== 1 && headerRecord.schemaVersion !== 2) {
    throw new Error('Replay schemaVersion is not supported.');
  }
  const schemaVersion = headerRecord.schemaVersion;

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

  const { commands, viewModelFrames, rcbFrames, endStep, endStateChecksum } = readReplayBodyAndEndRecord({
    lines,
    startIndex: 4,
    schemaVersion,
    maxCommands,
    maxViewModelFrames,
    maxRcbFrames,
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

  const assets = Object.freeze({
    manifestHash:
      assetsRecord.manifestHash === undefined || assetsRecord.manifestHash === null
        ? null
        : readNonEmptyString(assetsRecord.manifestHash, 'assets.manifestHash'),
  });

  const sim = Object.freeze({
    wiring,
    stepSizeMs,
    startStep,
    endStep,
    initialSnapshot: startSnapshot,
    commands,
    endStateChecksum,
  });

  if (schemaVersion === 1) {
    return Object.freeze({
      header: {
        fileType: SIM_REPLAY_FILE_TYPE,
        schemaVersion: 1,
        recordedAt,
        runtimeVersion,
      },
      content: {
        packId,
        packVersion,
        digest,
      },
      assets,
      sim,
    });
  }

  return Object.freeze({
    header: {
      fileType: SIM_REPLAY_FILE_TYPE,
      schemaVersion: 2,
      recordedAt,
      runtimeVersion,
    },
    content: {
      packId,
      packVersion,
      digest,
    },
    assets,
    sim,
    frames: Object.freeze({
      viewModels: viewModelFrames,
      rcbs: rcbFrames,
    }),
  });
}
