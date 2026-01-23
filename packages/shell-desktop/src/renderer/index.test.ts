import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createWebGpuRenderer = vi.fn();

vi.mock('../../../renderer-webgpu/dist/index.js', () => ({
  createWebGpuRenderer,
}));

type BeforeUnloadHandler = (() => void) | undefined;
type KeydownHandler = ((event: { code: string; repeat?: boolean }) => void) | undefined;
type PointerHandler = ((event: PointerEvent) => void) | undefined;
type WheelHandler = ((event: WheelEvent) => void) | undefined;

async function flushMicrotasks(maxTurns = 10): Promise<void> {
  for (let i = 0; i < maxTurns; i += 1) {
    await Promise.resolve();
  }
}

describe('shell-desktop renderer entrypoint', () => {
  let beforeUnloadHandler: BeforeUnloadHandler;
  let keydownHandler: KeydownHandler;
  let pointerDownHandler: PointerHandler;
  let pointerUpHandler: PointerHandler;
  let pointerMoveHandler: PointerHandler;
  let wheelHandler: WheelHandler;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let resizeObserverInstances: Array<{ trigger: () => void; disconnect: () => void }>;
  let canvasRect: { left: number; top: number };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    beforeUnloadHandler = undefined;
    keydownHandler = undefined;
    pointerDownHandler = undefined;
    pointerUpHandler = undefined;
    pointerMoveHandler = undefined;
    wheelHandler = undefined;
    rafCallbacks = new Map();
    nextRafId = 1;
    resizeObserverInstances = [];
    canvasRect = { left: 10, top: 20 };

    const outputElement = { textContent: '' } as unknown as HTMLPreElement;
    const canvasElement = {
      addEventListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'pointerdown') {
          pointerDownHandler = handler as PointerHandler;
        }
        if (event === 'pointerup') {
          pointerUpHandler = handler as PointerHandler;
        }
        if (event === 'pointermove') {
          pointerMoveHandler = handler as PointerHandler;
        }
        if (event === 'wheel') {
          wheelHandler = handler as WheelHandler;
        }
      }),
      removeEventListener: vi.fn(),
      getBoundingClientRect: vi.fn(() => canvasRect),
    } as unknown as HTMLCanvasElement;

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
      onSimStatus: vi.fn(() => vi.fn()),
    };

    (globalThis as unknown as { addEventListener?: unknown }).addEventListener = vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'beforeunload') {
          beforeUnloadHandler = handler;
        }
        if (event === 'keydown') {
          keydownHandler = handler as KeydownHandler;
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

  it('does nothing when required DOM elements are missing', async () => {
    const documentMock = globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } };
    documentMock.document.querySelector.mockImplementation((selector: string) => {
      if (selector === '#output') {
        return null;
      }
      if (selector === '#canvas') {
        return {} as unknown as HTMLCanvasElement;
      }
      return null;
    });

    await import('./index.js');
    await flushMicrotasks();

    const idleEngine = (globalThis as unknown as { idleEngine: { ping: ReturnType<typeof vi.fn> } }).idleEngine;
    expect(idleEngine.ping).not.toHaveBeenCalled();
    expect(createWebGpuRenderer).not.toHaveBeenCalled();
  });

  it('renders sim status updates and forwards key events', async () => {
    let simStatusListener: ((status: unknown) => void) | undefined;
    let frameListener: ((frame: unknown) => void) | undefined;

    const idleEngine = (
      globalThis as unknown as {
        idleEngine: {
          onSimStatus: ReturnType<typeof vi.fn>;
          onFrame: ReturnType<typeof vi.fn>;
          sendControlEvent: ReturnType<typeof vi.fn>;
        };
      }
    ).idleEngine;

    idleEngine.onSimStatus.mockImplementation((handler: (status: unknown) => void) => {
      simStatusListener = handler;
      return vi.fn();
    });

    idleEngine.onFrame.mockImplementation((handler: (frame: unknown) => void) => {
      frameListener = handler;
      return vi.fn();
    });

    await import('./index.js');
    await flushMicrotasks();

    const outputElement = (globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }).document
      .querySelector('#output') as { textContent: string };

    simStatusListener?.({ kind: 'starting' });
    expect(outputElement.textContent).toContain('Sim starting…');

    simStatusListener?.({ kind: 'running' });
    expect(outputElement.textContent).toContain('Sim running.');

    simStatusListener?.({ kind: 'crashed', reason: 'boom' });
    expect(outputElement.textContent).not.toContain('exitCode=');

    simStatusListener?.({ kind: 'crashed', reason: 'boom', exitCode: 1 });
    expect(outputElement.textContent).toContain('Sim crashed');
    expect(outputElement.textContent).toContain('exitCode=1');
    expect(outputElement.textContent).toContain('boom');

    frameListener?.({ frame: { step: 7, simTimeMs: 112 } });
    expect(outputElement.textContent).toContain('Sim step=7 simTimeMs=112');

    expect(keydownHandler).toBeTypeOf('function');
    keydownHandler?.({ code: 'KeyA', repeat: false });
    keydownHandler?.({ code: 'Space', repeat: true });
    expect(idleEngine.sendControlEvent).not.toHaveBeenCalled();

    keydownHandler?.({ code: 'Space', repeat: false });
    expect(idleEngine.sendControlEvent).toHaveBeenCalledWith({ intent: 'collect', phase: 'start' });
  });

  it('forwards pointer events with passthrough metadata', async () => {
    const idleEngine = (
      globalThis as unknown as { idleEngine: { sendControlEvent: ReturnType<typeof vi.fn> } }
    ).idleEngine;

    await import('./index.js');
    await flushMicrotasks();

    expect(pointerDownHandler).toBeTypeOf('function');
    expect(pointerUpHandler).toBeTypeOf('function');
    expect(wheelHandler).toBeTypeOf('function');

    pointerDownHandler?.({
      clientX: 30,
      clientY: 45,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    } as PointerEvent);

    wheelHandler?.({
      clientX: 40,
      clientY: 55,
      button: 0,
      buttons: 0,
      deltaX: 1,
      deltaY: 2,
      deltaZ: 0,
      deltaMode: 0,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    } as WheelEvent);

    expect(idleEngine.sendControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'mouse-down',
        phase: 'start',
        metadata: expect.objectContaining({
          passthrough: true,
          x: 30 - canvasRect.left,
          y: 45 - canvasRect.top,
          button: 0,
          buttons: 1,
          pointerType: 'mouse',
          modifiers: { alt: false, ctrl: false, meta: false, shift: true },
        }),
      }),
    );

    expect(idleEngine.sendControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'mouse-wheel',
        phase: 'repeat',
        metadata: expect.objectContaining({
          passthrough: true,
          x: 40 - canvasRect.left,
          y: 55 - canvasRect.top,
          deltaX: 1,
          deltaY: 2,
          deltaZ: 0,
          deltaMode: 0,
          modifiers: { alt: false, ctrl: true, meta: false, shift: false },
        }),
      }),
    );
  });

  it('coalesces pointer move events to one per frame', async () => {
    const idleEngine = (
      globalThis as unknown as { idleEngine: { sendControlEvent: ReturnType<typeof vi.fn> } }
    ).idleEngine;

    await import('./index.js');
    await flushMicrotasks();

    expect(pointerMoveHandler).toBeTypeOf('function');

    pointerMoveHandler?.({
      clientX: 30,
      clientY: 45,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    } as PointerEvent);

    pointerMoveHandler?.({
      clientX: 36,
      clientY: 50,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    } as PointerEvent);

    expect(idleEngine.sendControlEvent).not.toHaveBeenCalled();

    const rafEntries = Array.from(rafCallbacks.entries());
    const [moveId, moveCallback] = rafEntries[rafEntries.length - 1] as [number, FrameRequestCallback];
    rafCallbacks.delete(moveId);
    moveCallback(0);

    expect(idleEngine.sendControlEvent).toHaveBeenCalledTimes(1);
    expect(idleEngine.sendControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'mouse-move',
        phase: 'repeat',
        metadata: expect.objectContaining({
          passthrough: true,
          x: 36 - canvasRect.left,
          y: 50 - canvasRect.top,
          pointerType: 'mouse',
        }),
      }),
    );
  });

  it('renders IPC subscription failures to the output view', async () => {
    const idleEngine = (
      globalThis as unknown as {
        idleEngine: {
          onSimStatus: ReturnType<typeof vi.fn>;
          onFrame: ReturnType<typeof vi.fn>;
        };
      }
    ).idleEngine;

    idleEngine.onSimStatus.mockImplementation(() => {
      throw new Error('no sim');
    });
    idleEngine.onFrame.mockImplementation(() => {
      throw new Error('no frame');
    });

    await import('./index.js');
    await flushMicrotasks();

    const outputElement = (globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }).document
      .querySelector('#output') as { textContent: string };
    expect(outputElement.textContent).toContain('Sim error:');
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
    callback(0);

    expect(firstRenderer.render).toHaveBeenCalledTimes(1);
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
      if (capturedOptions.length === 2) {
        options.onDeviceLost?.({ reason: 'device-lost-during-recovery' });
        options.onDeviceLost?.({});
      }
      return capturedOptions.length === 1 ? firstRenderer : recoveredRenderer;
    });

    await import('./index.js');
    await flushMicrotasks();

    expect(capturedOptions).toHaveLength(1);
    capturedOptions[0]?.onDeviceLost?.({});
    capturedOptions[0]?.onDeviceLost?.({ reason: 'test' });
    capturedOptions[0]?.onDeviceLost?.({ reason: 'ignored-while-recovering' });
    capturedOptions[0]?.onDeviceLost?.({ reason: undefined });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(createWebGpuRenderer).toHaveBeenCalledTimes(2);

    const outputElement = (globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }).document
      .querySelector('#output') as { textContent: string };
    expect(outputElement.textContent).toContain('WebGPU ok (recovered).');
  });

  it('reports when WebGPU recovery fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const firstRenderer = {
      render: vi.fn(() => {
        throw new Error('render boom');
      }),
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    createWebGpuRenderer.mockResolvedValueOnce(firstRenderer).mockRejectedValueOnce(new Error('no adapter'));

    await import('./index.js');
    await flushMicrotasks();

    const outputElement = (
      globalThis as unknown as { document: { querySelector: ReturnType<typeof vi.fn> } }
    ).document.querySelector('#output') as { textContent: string };

    const [id, callback] = rafCallbacks.entries().next().value as [number, FrameRequestCallback];
    rafCallbacks.delete(id);
    callback(0);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(firstRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(outputElement.textContent).toContain('WebGPU recovery failed:');
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
