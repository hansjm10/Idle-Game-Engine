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
    const assetBytes = new Uint8Array([1, 2, 3]).buffer;
    invoke.mockResolvedValueOnce({ message: 'pong-from-test' }).mockResolvedValueOnce(assetBytes);

    await import('./preload.cjs');

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = exposeInMainWorld.mock.calls[0] as [string, IdleEngineApi];

    expect(key).toBe(IDLE_ENGINE_API_KEY);
    expect(typeof api.ping).toBe('function');
    expect(typeof api.readAsset).toBe('function');
    expect(typeof api.sendControlEvent).toBe('function');
    expect(typeof api.sendInputEvent).toBe('function');
    expect(typeof api.sendRendererDiagnostics).toBe('function');
    expect(typeof api.sendRendererLog).toBe('function');
    expect(typeof api.onFrame).toBe('function');
    expect(typeof api.onSimStatus).toBe('function');

    const message = 'hello-from-test';
    await expect(api.ping(message)).resolves.toBe('pong-from-test');
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.ping, { message });

    const assetUrl = 'file:///tmp/test';
    await expect(api.readAsset(assetUrl)).resolves.toBe(assetBytes);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.readAsset, { url: assetUrl });

    api.sendControlEvent({ intent: 'test-intent', phase: 'start' });
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.controlEvent, {
      intent: 'test-intent',
      phase: 'start',
    });

    const inputEventEnvelope = {
      schemaVersion: 1 as const,
      event: {
        kind: 'pointer' as const,
        intent: 'mouse-down' as const,
        phase: 'start' as const,
        x: 100,
        y: 200,
        button: 0,
        buttons: 1,
        pointerType: 'mouse' as const,
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      },
    };
    api.sendInputEvent(inputEventEnvelope);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.inputEvent, inputEventEnvelope);

    const rendererDiagnostics = {
      outputText: 'IPC ok\nSim running\nWebGPU ok.',
      rendererState: 'running',
      webgpu: { status: 'ok' as const },
    };
    api.sendRendererDiagnostics(rendererDiagnostics);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.rendererDiagnostics, rendererDiagnostics);

    const rendererLog = {
      severity: 'info' as const,
      subsystem: 'webgpu',
      message: 'WebGPU initialized',
      metadata: { adapter: 'test' },
    };
    api.sendRendererLog(rendererLog);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.rendererLog, rendererLog);

    const frameHandler = vi.fn();
    const simStatusHandler = vi.fn();
    on
      .mockImplementationOnce((_channel: string, listener: (...args: unknown[]) => void) => {
        listener({}, { frame: { step: 1 } });
      })
      .mockImplementationOnce((_channel: string, listener: (...args: unknown[]) => void) => {
        listener({}, { kind: 'crashed', reason: 'test crash', exitCode: 1 });
      });

    const unsubscribe = api.onFrame(frameHandler);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith(IPC_CHANNELS.frame, expect.any(Function));
    expect(frameHandler).toHaveBeenCalledWith({ frame: { step: 1 } });

    const unsubscribeSimStatus = api.onSimStatus(simStatusHandler);
    expect(on).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledWith(IPC_CHANNELS.simStatus, expect.any(Function));
    expect(simStatusHandler).toHaveBeenCalledWith({ kind: 'crashed', reason: 'test crash', exitCode: 1 });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.frame, expect.any(Function));

    unsubscribeSimStatus();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.simStatus, expect.any(Function));
  });
});
