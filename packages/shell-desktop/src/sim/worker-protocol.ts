import type { Command } from '@idle-engine/core';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

import type { GameStateSaveFormat } from '../runtime-harness.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured error envelope used by save/load protocol responses.
 */
export type InterfaceError = Readonly<{
  code:
    | 'PROTOCOL_VALIDATION_FAILED'
    | 'CAPABILITY_UNAVAILABLE'
    | 'SERIALIZE_FAILED'
    | 'INVALID_SAVE_DATA'
    | 'HYDRATE_FAILED'
    | 'INVALID_OFFLINE_CATCHUP_REQUEST'
    | 'REQUEST_TIMEOUT'
    | 'IO_ERROR';
  message: string;
  retriable: boolean;
}>;

/**
 * Capability flags reported by the worker at init time.
 */
export type SimWorkerCapabilities = Readonly<{
  canSerialize: boolean;
  canOfflineCatchup: boolean;
}>;

// ─────────────────────────────────────────────────────────────────────────────
// Inbound messages (main -> worker)
// ─────────────────────────────────────────────────────────────────────────────

export type SimWorkerInitMessage = Readonly<{
  kind: 'init';
  stepSizeMs: number;
  maxStepsPerFrame: number;
}>;

export type SimWorkerTickMessage = Readonly<{
  kind: 'tick';
  deltaMs: number;
}>;

export type SimWorkerEnqueueCommandsMessage = Readonly<{
  kind: 'enqueueCommands';
  commands: readonly Command[];
}>;

export type SimWorkerShutdownMessage = Readonly<{
  kind: 'shutdown';
}>;

/**
 * Request the worker to serialize current game state.
 */
export type SimWorkerSerializeMessage = Readonly<{
  kind: 'serialize';
  requestId: string;
}>;

/**
 * Request the worker to hydrate game state from a save.
 */
export type SimWorkerHydrateMessage = Readonly<{
  kind: 'hydrate';
  requestId: string;
  save: GameStateSaveFormat;
}>;

export type SimWorkerInboundMessage =
  | SimWorkerInitMessage
  | SimWorkerTickMessage
  | SimWorkerEnqueueCommandsMessage
  | SimWorkerShutdownMessage
  | SimWorkerSerializeMessage
  | SimWorkerHydrateMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Outbound messages (worker -> main)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Protocol v2 ready message with capability signaling.
 */
export type SimWorkerReadyMessageV2 = Readonly<{
  kind: 'ready';
  protocolVersion: 2;
  stepSizeMs: number;
  nextStep: number;
  capabilities: SimWorkerCapabilities;
}>;

/**
 * Legacy ready shape (protocol v1 / pre-capability workers).
 * Missing `protocolVersion` and `capabilities`; main normalizes to
 * protocol v1 with `{ canSerialize: false, canOfflineCatchup: false }`.
 */
export type SimWorkerReadyMessageLegacy = Readonly<{
  kind: 'ready';
  stepSizeMs: number;
  nextStep: number;
}>;

/**
 * Union of all valid ready shapes the main process must handle.
 */
export type SimWorkerReadyMessage =
  | SimWorkerReadyMessageV2
  | SimWorkerReadyMessageLegacy;

export type SimWorkerFrameMessage = Readonly<{
  kind: 'frame';
  frame?: RenderCommandBuffer;
  droppedFrames: number;
  nextStep: number;
}>;

export type SimWorkerErrorMessage = Readonly<{
  kind: 'error';
  error: string;
}>;

/**
 * Successful serialization result with save bytes.
 */
export type SimWorkerSaveDataSuccessMessage = Readonly<{
  kind: 'saveData';
  requestId: string;
  ok: true;
  data: Uint8Array;
}>;

/**
 * Failed serialization result with structured error.
 */
export type SimWorkerSaveDataErrorMessage = Readonly<{
  kind: 'saveData';
  requestId: string;
  ok: false;
  error: InterfaceError;
}>;

/**
 * Save data response envelope (success or error).
 */
export type SimWorkerSaveDataMessage =
  | SimWorkerSaveDataSuccessMessage
  | SimWorkerSaveDataErrorMessage;

/**
 * Successful hydration result.
 */
export type SimWorkerHydrateResultSuccessMessage = Readonly<{
  kind: 'hydrateResult';
  requestId: string;
  ok: true;
  nextStep: number;
}>;

/**
 * Failed hydration result with structured error.
 */
export type SimWorkerHydrateResultErrorMessage = Readonly<{
  kind: 'hydrateResult';
  requestId: string;
  ok: false;
  error: InterfaceError;
}>;

/**
 * Hydrate result response envelope (success or error).
 */
export type SimWorkerHydrateResultMessage =
  | SimWorkerHydrateResultSuccessMessage
  | SimWorkerHydrateResultErrorMessage;

export type SimWorkerOutboundMessage =
  | SimWorkerReadyMessage
  | SimWorkerFrameMessage
  | SimWorkerErrorMessage
  | SimWorkerSaveDataMessage
  | SimWorkerHydrateResultMessage;
