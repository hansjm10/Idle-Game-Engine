import type { IdleEngineApi, IpcInvokeMap } from './ipc.js';

const electron = require('electron') as typeof import('electron');

const { contextBridge, ipcRenderer } = electron;

const IDLE_ENGINE_API_KEY = 'idleEngine' as const;

const IPC_CHANNELS = {
  ping: 'idle-engine:ping',
} as const;

async function invoke<K extends keyof IpcInvokeMap>(
  channel: K,
  request: IpcInvokeMap[K]['request'],
): Promise<IpcInvokeMap[K]['response']> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcInvokeMap[K]['response']>;
}

const idleEngineApi: IdleEngineApi = {
  ping: async (message) => {
    const response = await invoke(IPC_CHANNELS.ping, { message });
    return response.message;
  },
};

contextBridge.exposeInMainWorld(IDLE_ENGINE_API_KEY, idleEngineApi);
