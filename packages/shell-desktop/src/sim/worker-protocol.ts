import type { Command } from '@idle-engine/core';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

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

export type SimWorkerInboundMessage =
  | SimWorkerInitMessage
  | SimWorkerTickMessage
  | SimWorkerEnqueueCommandsMessage
  | SimWorkerShutdownMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Outbound messages (worker -> main)
// ─────────────────────────────────────────────────────────────────────────────

export type SimWorkerReadyMessage = Readonly<{
  kind: 'ready';
  stepSizeMs: number;
  nextStep: number;
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

export type SimWorkerOutboundMessage =
  | SimWorkerReadyMessage
  | SimWorkerFrameMessage
  | SimWorkerErrorMessage;
