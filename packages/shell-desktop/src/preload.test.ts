import { describe, expect, it, vi } from 'vitest';

import { IDLE_ENGINE_API_KEY, IPC_CHANNELS } from './ipc.js';
import type { IdleEngineApi } from './ipc.js';

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke },
}));

describe('shell-desktop preload', () => {
  it('exposes a typed idleEngine API and routes ping via ipcRenderer.invoke', async () => {
    invoke.mockResolvedValueOnce({ message: 'pong-from-test' });

    await import('./preload.js');

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = exposeInMainWorld.mock.calls[0] as [string, IdleEngineApi];

    expect(key).toBe(IDLE_ENGINE_API_KEY);
    expect(typeof api.ping).toBe('function');

    const message = 'hello-from-test';
    await expect(api.ping(message)).resolves.toBe('pong-from-test');
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.ping, { message });
  });
});
