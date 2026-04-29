import type { Command, RuntimeAccumulatorBacklogState } from '@idle-engine/core';
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

export type SimOfflineCatchupStatus = Readonly<{
  busy: boolean;
  pendingSteps: number;
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

export type SimWorkerDrainOfflineCatchupMessage = Readonly<{
  kind: 'drainOfflineCatchup';
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
  | SimWorkerDrainOfflineCatchupMessage
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
  runtimeBacklog?: RuntimeAccumulatorBacklogState;
  offlineCatchup?: SimOfflineCatchupStatus;
}>;

export type SimWorkerFrameMessage = Readonly<{
  kind: 'frame';
  frame?: RenderCommandBuffer;
  droppedFrames: number;
  nextStep: number;
  runtimeBacklog?: RuntimeAccumulatorBacklogState;
  offlineCatchup?: SimOfflineCatchupStatus;
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
  frame?: RenderCommandBuffer;
  runtimeBacklog?: RuntimeAccumulatorBacklogState;
  offlineCatchup?: SimOfflineCatchupStatus;
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
