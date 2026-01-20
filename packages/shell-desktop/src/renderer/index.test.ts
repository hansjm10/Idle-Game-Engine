import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createWebGpuRenderer = vi.fn();

vi.mock('../../../renderer-webgpu/dist/index.js', () => ({
  createWebGpuRenderer,
}));

type BeforeUnloadHandler = (() => void) | undefined;

async function flushMicrotasks(maxTurns = 10): Promise<void> {
  for (let i = 0; i < maxTurns; i += 1) {
    await Promise.resolve();
  }
}

describe('shell-desktop renderer entrypoint', () => {
  let beforeUnloadHandler: BeforeUnloadHandler;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let resizeObserverInstances: Array<{ trigger: () => void; disconnect: () => void }>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    beforeUnloadHandler = undefined;
    rafCallbacks = new Map();
    nextRafId = 1;
    resizeObserverInstances = [];

    const outputElement = { textContent: '' } as unknown as HTMLPreElement;
    const canvasElement = {} as unknown as HTMLCanvasElement;

    (globalThis as unknown as { document?: unknown }).document = {
      querySelector: vi.fn((selector: string) => {
        if (selector === '#output') {
          return outputElement;
        }
        if (selector === '#canvas') {
          return canvasElement;
        }
        return null;
      }),
    };

    (globalThis as unknown as { idleEngine?: unknown }).idleEngine = {
      ping: vi.fn(async () => 'pong'),
      sendControlEvent: vi.fn(),
      onFrame: vi.fn(() => vi.fn()),
    };

    (globalThis as unknown as { addEventListener?: unknown }).addEventListener = vi.fn(
      (event: string, handler: () => void) => {
        if (event === 'beforeunload') {
          beforeUnloadHandler = handler;
        }
      },
    );

    (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
      callback: FrameRequestCallback,
    ): number => {
      const id = nextRafId;
      nextRafId += 1;
      rafCallbacks.set(id, callback);
      return id;
    };

    (globalThis as unknown as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: number): void => {
      rafCallbacks.delete(id);
    };

    class TestResizeObserver {
      readonly disconnect = vi.fn();

      private readonly callback: () => void;

      constructor(callback: () => void) {
        this.callback = callback;
      }

      observe(): void {
        resizeObserverInstances.push({ trigger: () => this.callback(), disconnect: this.disconnect });
      }
    }

    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      TestResizeObserver as unknown as typeof ResizeObserver;

    createWebGpuRenderer.mockImplementation(async () => ({
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { idleEngine?: unknown }).idleEngine;
    delete (globalThis as unknown as { addEventListener?: unknown }).addEventListener;
    delete (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    delete (globalThis as unknown as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it('starts IPC ping + WebGPU renderer loop', async () => {
    await import('./index.js');
    await flushMicrotasks();

    expect(createWebGpuRenderer).toHaveBeenCalledTimes(1);
    expect(resizeObserverInstances).toHaveLength(1);

    const renderer = (await createWebGpuRenderer.mock.results[0]?.value) as unknown as {
      resize: ReturnType<typeof vi.fn>;
    };
    expect(renderer.resize).not.toHaveBeenCalled();
    resizeObserverInstances[0]?.trigger();
    expect(renderer.resize).toHaveBeenCalledTimes(1);

    expect(rafCallbacks.size).toBe(1);
    const [id, callback] = rafCallbacks.entries().next().value as [number, FrameRequestCallback];
    rafCallbacks.delete(id);
    callback(0);
    expect(rafCallbacks.size).toBe(1);

    expect(beforeUnloadHandler).toBeTypeOf('function');
    beforeUnloadHandler?.();
  });

  it('renders IPC errors to the output view', async () => {
    const idleEngine = (globalThis as unknown as { idleEngine: { ping: ReturnType<typeof vi.fn> } }).idleEngine;
    idleEngine.ping.mockRejectedValueOnce(new Error('no ipc'));

    await import('./index.js');
    await flushMicrotasks();

    const outputElement = (
      globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }
    ).document.querySelector('#output') as { textContent: string };
    expect(outputElement.textContent).toContain('IPC error:');
  });

  it('recovers when render throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const firstRenderer = {
      render: vi.fn(() => {
        throw new Error('render boom');
      }),
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    const recoveredRenderer = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    createWebGpuRenderer.mockResolvedValueOnce(firstRenderer).mockResolvedValueOnce(recoveredRenderer);

    await import('./index.js');
    await flushMicrotasks();

    const outputElement = (
      globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }
    ).document.querySelector('#output') as { textContent: string };

    expect(rafCallbacks.size).toBe(1);
    const [id, callback] = rafCallbacks.entries().next().value as [number, FrameRequestCallback];
    rafCallbacks.delete(id);
    callback(0);

    expect(firstRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(outputElement.textContent).toContain('Attempting recovery');
    expect(rafCallbacks.size).toBe(0);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(createWebGpuRenderer).toHaveBeenCalledTimes(2);
    expect(outputElement.textContent).toContain('WebGPU ok (recovered).');
    expect(rafCallbacks.size).toBe(1);
  });

  it('recovers when the WebGPU device is lost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const firstRenderer = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    const recoveredRenderer = { render: vi.fn(), resize: vi.fn(), dispose: vi.fn() };

    const capturedOptions: Array<{ onDeviceLost?: (error: { reason?: string }) => void }> = [];
    createWebGpuRenderer.mockImplementation(async (_canvas: unknown, options: { onDeviceLost?: (error: { reason?: string }) => void }) => {
      capturedOptions.push(options);
      return capturedOptions.length === 1 ? firstRenderer : recoveredRenderer;
    });

    await import('./index.js');
    await flushMicrotasks();

    expect(capturedOptions).toHaveLength(1);
    capturedOptions[0]?.onDeviceLost?.({ reason: 'test' });
    capturedOptions[0]?.onDeviceLost?.({ reason: 'ignored-while-recovering' });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(createWebGpuRenderer).toHaveBeenCalledTimes(2);

    const outputElement = (globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }).document
      .querySelector('#output') as { textContent: string };
    expect(outputElement.textContent).toContain('WebGPU ok (recovered).');
  });

  it('reports when WebGPU initialization fails', async () => {
    createWebGpuRenderer.mockRejectedValueOnce(new Error('no adapter'));

    await import('./index.js');
    await flushMicrotasks();

    const outputElement = (globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }).document
      .querySelector('#output') as { textContent: string };
    expect(outputElement.textContent).toContain('WebGPU error:');
  });
});
