import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

import { IDLE_ENGINE_API_KEY, IPC_CHANNELS } from './ipc.js';
import type { IdleEngineApi } from './ipc.js';

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

const require = createRequire(import.meta.url);
const electronModulePath = require.resolve('electron');
require.cache[electronModulePath] = {
  exports: {
    contextBridge: { exposeInMainWorld },
    ipcRenderer: { invoke, send, on, removeListener },
  },
} as unknown as NodeJS.Module;

describe('shell-desktop preload', () => {
  it('exposes a typed idleEngine API and routes calls via ipcRenderer', async () => {
    invoke.mockResolvedValueOnce({ message: 'pong-from-test' });

    await import('./preload.cjs');

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = exposeInMainWorld.mock.calls[0] as [string, IdleEngineApi];

    expect(key).toBe(IDLE_ENGINE_API_KEY);
    expect(typeof api.ping).toBe('function');
    expect(typeof api.sendControlEvent).toBe('function');
    expect(typeof api.onFrame).toBe('function');

    const message = 'hello-from-test';
    await expect(api.ping(message)).resolves.toBe('pong-from-test');
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.ping, { message });

    api.sendControlEvent({ intent: 'test-intent', phase: 'start' });
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.controlEvent, {
      intent: 'test-intent',
      phase: 'start',
    });

    const frameHandler = vi.fn();
    on.mockImplementationOnce((_channel: string, listener: (...args: unknown[]) => void) => {
      listener({}, { frame: { step: 1 } });
    });

    const unsubscribe = api.onFrame(frameHandler);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith(IPC_CHANNELS.frame, expect.any(Function));
    expect(frameHandler).toHaveBeenCalledWith({ frame: { step: 1 } });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.frame, expect.any(Function));
  });
});
