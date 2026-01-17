import { contextBridge, ipcRenderer } from 'electron';
import { IDLE_ENGINE_API_KEY, IPC_CHANNELS } from './ipc.js';
import type { IdleEngineApi, IpcInvokeMap } from './ipc.js';

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

