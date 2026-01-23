import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

export const IDLE_ENGINE_API_KEY = 'idleEngine' as const;

export const IPC_CHANNELS = {
  ping: 'idle-engine:ping',
  controlEvent: 'idle-engine:control-event',
  frame: 'idle-engine:frame',
  simStatus: 'idle-engine:sim-status',
} as const;

export type PingRequest = {
  message: string;
};

export type PingResponse = {
  message: string;
};

export type ShellControlEventPhase = 'start' | 'repeat' | 'end';

export type ShellControlEvent = Readonly<{
  intent: string;
  phase: ShellControlEventPhase;
  value?: number;
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
};

export type IdleEngineApi = {
  ping: (message: string) => Promise<string>;
  sendControlEvent: (event: ShellControlEvent) => void;
  onFrame: (handler: (frame: ShellFramePayload) => void) => () => void;
  onSimStatus: (handler: (status: ShellSimStatusPayload) => void) => () => void;
};
