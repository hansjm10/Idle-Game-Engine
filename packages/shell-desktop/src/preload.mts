import { contextBridge, ipcRenderer } from 'electron';
import {
  IDLE_ENGINE_API_KEY,
  IPC_CHANNELS,
  type IdleEngineApi,
  type IpcInvokeMap,
  type ShellFramePayload,
  type ShellInputEventEnvelope,
  type ShellRendererDiagnosticsPayload,
  type ShellRendererLogPayload,
  type ShellSimStatusPayload,
} from './ipc.js';

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
  readAsset: async (url) => invoke(IPC_CHANNELS.readAsset, { url }),
  sendControlEvent: (event) => {
    ipcRenderer.send(IPC_CHANNELS.controlEvent, event);
  },
  sendInputEvent: (envelope: ShellInputEventEnvelope) => {
    ipcRenderer.send(IPC_CHANNELS.inputEvent, envelope);
  },
  sendRendererDiagnostics: (payload: ShellRendererDiagnosticsPayload) => {
    ipcRenderer.send(IPC_CHANNELS.rendererDiagnostics, payload);
  },
  sendRendererLog: (payload: ShellRendererLogPayload) => {
    ipcRenderer.send(IPC_CHANNELS.rendererLog, payload);
  },
  onFrame: (handler) => {
    const listener = (_event: unknown, frame: unknown) => {
      handler(frame as ShellFramePayload);
    };

    ipcRenderer.on(IPC_CHANNELS.frame, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.frame, listener);
    };
  },
  onSimStatus: (handler) => {
    const listener = (_event: unknown, status: unknown) => {
      handler(status as ShellSimStatusPayload);
    };

    ipcRenderer.on(IPC_CHANNELS.simStatus, listener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.simStatus, listener);
    };
  },
};

contextBridge.exposeInMainWorld(IDLE_ENGINE_API_KEY, idleEngineApi);
