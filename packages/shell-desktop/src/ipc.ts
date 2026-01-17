export const IDLE_ENGINE_API_KEY = 'idleEngine' as const;

export const IPC_CHANNELS = {
  ping: 'idle-engine:ping',
} as const;

export type PingRequest = {
  message: string;
};

export type PingResponse = {
  message: string;
};

export type IpcInvokeMap = {
  [IPC_CHANNELS.ping]: {
    request: PingRequest;
    response: PingResponse;
  };
};

export type IdleEngineApi = {
  ping: (message: string) => Promise<string>;
};

