import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

export const IDLE_ENGINE_API_KEY = 'idleEngine' as const;

export const IPC_CHANNELS = {
  ping: 'idle-engine:ping',
  readAsset: 'idle-engine:read-asset',
  controlEvent: 'idle-engine:control-event',
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
   * Reserved keys used by the desktop shell:
   * - `passthrough: true`: if the active control scheme produces no commands for
   *   the event, the main process may enqueue a `SHELL_CONTROL_EVENT` command
   *   containing the raw event.
   *
   * Pointer events emitted by the desktop renderer include metadata such as:
   * - `x`, `y` (canvas-relative coordinates), `button`, `buttons`, `pointerType`,
   *   `modifiers` and (for wheel) `deltaX`, `deltaY`, `deltaZ`, `deltaMode`.
   */
  metadata?: Readonly<Record<string, unknown>>;
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
  onFrame: (handler: (frame: ShellFramePayload) => void) => () => void;
  onSimStatus: (handler: (status: ShellSimStatusPayload) => void) => () => void;
};
