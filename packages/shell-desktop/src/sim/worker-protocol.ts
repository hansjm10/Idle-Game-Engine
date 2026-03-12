import type { Command } from '@idle-engine/core';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

export type SimRuntimeCapabilities = Readonly<{
  canSerialize: boolean;
  canHydrate: boolean;
  supportsOfflineCatchup: boolean;
  saveFileStem?: string;
  saveSchemaVersion?: number;
  contentHash?: string;
  contentVersion?: string;
}>;

export const DEFAULT_SIM_RUNTIME_CAPABILITIES = Object.freeze({
  canSerialize: false,
  canHydrate: false,
  supportsOfflineCatchup: false,
}) satisfies SimRuntimeCapabilities;

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

export type SimWorkerSerializeMessage = Readonly<{
  kind: 'serialize';
  requestId: string;
}>;

export type SimWorkerHydrateMessage = Readonly<{
  kind: 'hydrate';
  requestId: string;
  state: unknown;
}>;

export type SimWorkerShutdownMessage = Readonly<{
  kind: 'shutdown';
}>;

export type SimWorkerInboundMessage =
  | SimWorkerInitMessage
  | SimWorkerTickMessage
  | SimWorkerEnqueueCommandsMessage
  | SimWorkerSerializeMessage
  | SimWorkerHydrateMessage
  | SimWorkerShutdownMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Outbound messages (worker -> main)
// ─────────────────────────────────────────────────────────────────────────────

export type SimWorkerReadyMessage = Readonly<{
  kind: 'ready';
  stepSizeMs: number;
  nextStep: number;
  capabilities?: SimRuntimeCapabilities;
}>;

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

export type SimWorkerSerializedMessage = Readonly<{
  kind: 'serialized';
  requestId: string;
  state: unknown;
}>;

export type SimWorkerHydratedMessage = Readonly<{
  kind: 'hydrated';
  requestId: string;
  nextStep: number;
  capabilities?: SimRuntimeCapabilities;
}>;

export type SimWorkerRequestErrorMessage = Readonly<{
  kind: 'requestError';
  requestId: string;
  error: string;
}>;

export type SimWorkerOutboundMessage =
  | SimWorkerReadyMessage
  | SimWorkerFrameMessage
  | SimWorkerErrorMessage
  | SimWorkerSerializedMessage
  | SimWorkerHydratedMessage
  | SimWorkerRequestErrorMessage;
