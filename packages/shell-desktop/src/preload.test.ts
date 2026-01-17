import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

import { IDLE_ENGINE_API_KEY, IPC_CHANNELS } from './ipc.js';
import type { IdleEngineApi } from './ipc.js';

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();

const require = createRequire(import.meta.url);
const electronModulePath = require.resolve('electron');
require.cache[electronModulePath] = {
  exports: {
    contextBridge: { exposeInMainWorld },
    ipcRenderer: { invoke },
  },
} as unknown as NodeJS.Module;

describe('shell-desktop preload', () => {
  it('exposes a typed idleEngine API and routes ping via ipcRenderer.invoke', async () => {
    invoke.mockResolvedValueOnce({ message: 'pong-from-test' });

    await import('./preload.cjs');

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = exposeInMainWorld.mock.calls[0] as [string, IdleEngineApi];

    expect(key).toBe(IDLE_ENGINE_API_KEY);
    expect(typeof api.ping).toBe('function');

    const message = 'hello-from-test';
    await expect(api.ping(message)).resolves.toBe('pong-from-test');
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.ping, { message });
  });
});
