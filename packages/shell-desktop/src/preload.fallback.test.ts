import { beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';

const exposeInMainWorld = vi.fn();
const preloadElectronModule = {
  contextBridge: {
    exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
};

function installElectronModule(electronModule: unknown): () => void {
  const moduleLoader = Module as typeof Module & {
    _load: (request: string, ...args: unknown[]) => unknown;
  };
  const originalLoad = moduleLoader._load;

  moduleLoader._load = ((request: string, ...args: unknown[]) => {
    if (request === 'electron') {
      return electronModule;
    }

    return originalLoad(request, ...args);
  }) as typeof moduleLoader._load;

  return () => {
    moduleLoader._load = originalLoad;
  };
}

describe('shell-desktop preload fallback resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    exposeInMainWorld.mockClear();
    delete (globalThis as typeof globalThis & {
      __idleEngineElectronPreloadTestModule__?: typeof preloadElectronModule;
    }).__idleEngineElectronPreloadTestModule__;
  });

  it('falls back to the test preload module when electron exports are unusable', async () => {
    const restoreElectronModule = installElectronModule({ default: {} });
    (globalThis as typeof globalThis & {
      __idleEngineElectronPreloadTestModule__?: typeof preloadElectronModule;
    }).__idleEngineElectronPreloadTestModule__ = preloadElectronModule;

    try {
      await import('./preload.cjs');
    } finally {
      restoreElectronModule();
      delete (globalThis as typeof globalThis & {
        __idleEngineElectronPreloadTestModule__?: typeof preloadElectronModule;
      }).__idleEngineElectronPreloadTestModule__;
    }

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
  });

  it('throws when electron preload APIs are unavailable', async () => {
    const restoreElectronModule = installElectronModule({ default: {} });

    try {
      await expect(import('./preload.cjs')).rejects.toThrow(
        'Electron preload APIs are unavailable in this environment.',
      );
    } finally {
      restoreElectronModule();
    }
  });
});
