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

describe('shell-desktop preload default export resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    exposeInMainWorld.mockClear();
  });

  it('supports electron preload APIs exposed under a default export', async () => {
    const restoreElectronModule = installElectronModule({ default: preloadElectronModule });

    try {
      await import('./preload.cjs');
    } finally {
      restoreElectronModule();
    }

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
  });
});
