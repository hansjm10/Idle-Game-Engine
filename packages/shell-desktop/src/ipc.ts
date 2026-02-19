import type { InputEvent } from '@idle-engine/core';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

export const IDLE_ENGINE_API_KEY = 'idleEngine' as const;

export const IPC_CHANNELS = {
  ping: 'idle-engine:ping',
  readAsset: 'idle-engine:read-asset',
  controlEvent: 'idle-engine:control-event',
  inputEvent: 'idle-engine:input-event',
  rendererDiagnostics: 'idle-engine:renderer-diagnostics',
  rendererLog: 'idle-engine:renderer-log',
  frame: 'idle-engine:frame',
  simStatus: 'idle-engine:sim-status',
} as const;

export const SHELL_CONTROL_EVENT_COMMAND_TYPE = 'SHELL_CONTROL_EVENT' as const;

export type PingRequest = {
  message: string;
};

export type PingResponse = {
  message: string;
};

export type ReadAssetRequest = Readonly<{
  url: string;
}>;

export type ShellControlEventPhase = 'start' | 'repeat' | 'end';

export type ShellControlEvent = Readonly<{
  intent: string;
  phase: ShellControlEventPhase;
  value?: number;
  /**
   * Optional extra event data passed through the IPC boundary.
   *
   * **Note:** The desktop shell does not emit `SHELL_CONTROL_EVENT` from renderer
   * inputs. The `metadata.passthrough` key has no effect; pointer/wheel events are
   * sent exclusively via the `idle-engine:input-event` channel (see
   * {@link ShellInputEventEnvelope}). Control events received on
   * `idle-engine:control-event` are processed by the control scheme mapping only.
   *
   * Legacy code may still include metadata keys such as `x`, `y`, `button`, etc.,
   * but they are not used for command generation.
   */
  metadata?: Readonly<Record<string, unknown>>;
}>;

/**
 * Typed envelope for input events sent from renderer to main.
 *
 * The `schemaVersion` field gates IPC-level compatibility:
 * - Version 1 is the initial release (issue #850).
 * - Unknown versions are dropped at the IPC boundary (not enqueued).
 *
 * The `event` field uses the canonical `InputEvent` type from `@idle-engine/core`
 * to avoid shell->core dependency issues.
 */
export type ShellInputEventEnvelope = Readonly<{
  schemaVersion: 1;
  event: InputEvent;
}>;

export type ShellRendererLogSeverity = 'debug' | 'info' | 'warn' | 'error';

export type ShellRendererLogPayload = Readonly<{
  severity: ShellRendererLogSeverity;
  subsystem: string;
  message: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ShellRendererWebGpuHealthStatus = 'ok' | 'lost' | 'recovered';

export type ShellRendererDiagnosticsPayload = Readonly<{
  outputText: string;
  errorBannerText?: string;
  rendererState?: string;
  webgpu?: Readonly<{
    status: ShellRendererWebGpuHealthStatus;
    lastLossReason?: string;
  }>;
}>;

export type ShellFramePayload = RenderCommandBuffer;

export type ShellSimStatusPayload =
  | Readonly<{ kind: 'starting' }>
  | Readonly<{ kind: 'running' }>
  | Readonly<{
      kind: 'stopped' | 'crashed';
      reason: string;
      exitCode?: number;
    }>;

export type IpcInvokeMap = {
  [IPC_CHANNELS.ping]: {
    request: PingRequest;
    response: PingResponse;
  };
  [IPC_CHANNELS.readAsset]: {
    request: ReadAssetRequest;
    response: ArrayBuffer;
  };
};

export type IdleEngineApi = {
  ping: (message: string) => Promise<string>;
  readAsset: (url: string) => Promise<ArrayBuffer>;
  sendControlEvent: (event: ShellControlEvent) => void;
  sendInputEvent: (envelope: ShellInputEventEnvelope) => void;
  sendRendererDiagnostics: (payload: ShellRendererDiagnosticsPayload) => void;
  sendRendererLog: (payload: ShellRendererLogPayload) => void;
  onFrame: (handler: (frame: ShellFramePayload) => void) => () => void;
  onSimStatus: (handler: (status: ShellSimStatusPayload) => void) => () => void;
};
