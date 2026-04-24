type ElectronPreloadModule = Pick<typeof import('electron'), 'contextBridge' | 'ipcRenderer'>;

function isElectronPreloadModule(value: unknown): value is ElectronPreloadModule {
  return typeof value === 'object'
    && value !== null
    && 'contextBridge' in value
    && 'ipcRenderer' in value;
}

function getDefaultExport(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('default' in value)) {
    return undefined;
  }

  return (value as { default?: unknown }).default;
}

function resolveElectronPreloadModule(): ElectronPreloadModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronModule = require('electron') as unknown;
  if (isElectronPreloadModule(electronModule)) {
    return electronModule;
  }

  const defaultElectronModule = getDefaultExport(electronModule);
  if (isElectronPreloadModule(defaultElectronModule)) {
    return defaultElectronModule;
  }

  const testElectronModule = (globalThis as typeof globalThis & {
    __idleEngineElectronPreloadTestModule__?: ElectronPreloadModule;
  }).__idleEngineElectronPreloadTestModule__;
  if (isElectronPreloadModule(testElectronModule)) {
    return testElectronModule;
  }

  throw new TypeError('Electron preload APIs are unavailable in this environment.');
}

const { contextBridge, ipcRenderer } = resolveElectronPreloadModule();

import type {
  IdleEngineApi,
  IpcInvokeMap,
  ShellFramePayload,
  ShellInputEventEnvelope,
  ShellRendererDiagnosticsPayload,
  ShellRendererLogPayload,
  ShellSimStatusPayload,
} from './ipc.js';

// Sandboxed preloads cannot import local runtime modules, so these values stay inline
// and are checked against the shared IPC contract at compile time.
const IDLE_ENGINE_API_KEY = 'idleEngine' as const satisfies typeof import('./ipc.js').IDLE_ENGINE_API_KEY;
const IPC_CHANNELS = {
  ping: 'idle-engine:ping',
  readAsset: 'idle-engine:read-asset',
  controlEvent: 'idle-engine:control-event',
  inputEvent: 'idle-engine:input-event',
  rendererDiagnostics: 'idle-engine:renderer-diagnostics',
  rendererLog: 'idle-engine:renderer-log',
  frame: 'idle-engine:frame',
  simStatus: 'idle-engine:sim-status',
} as const satisfies typeof import('./ipc.js').IPC_CHANNELS;

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
