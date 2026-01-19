import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __test__, createWebGpuRenderer, WebGpuNotSupportedError } from './webgpu-renderer.js';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

describe('renderer-webgpu', () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDevicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'devicePixelRatio',
  );

  function setNavigator(value: unknown): void {
    Object.defineProperty(globalThis, 'navigator', {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  function setDevicePixelRatio(value: number | undefined): void {
    if (value === undefined) {
      delete (globalThis as unknown as { devicePixelRatio?: number }).devicePixelRatio;
      return;
    }

    Object.defineProperty(globalThis, 'devicePixelRatio', {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      delete (globalThis as unknown as { navigator?: unknown }).navigator;
    }

    if (originalDevicePixelRatioDescriptor) {
      Object.defineProperty(globalThis, 'devicePixelRatio', originalDevicePixelRatioDescriptor);
    } else {
      delete (globalThis as unknown as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });

  it('converts RGBA ints to GPUColor', () => {
    expect(__test__.colorRgbaToGpuColor(0xff_00_00_ff)).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    });

    expect(__test__.colorRgbaToGpuColor(0x00_80_ff_40)).toEqual({
      r: 0,
      g: 128 / 255,
      b: 1,
      a: 64 / 255,
    });
  });

  it('derives a sane canvas pixel size', () => {
    const canvas = {
      clientWidth: 0,
      clientHeight: 10,
    } as HTMLCanvasElement;

    expect(__test__.getCanvasPixelSize(canvas, 2)).toEqual({ width: 1, height: 20 });
  });

  it('defaults to opaque black when RCB has no clear draw', () => {
    const rcb = {
      frame: {
        schemaVersion: 1,
        step: 0,
        simTimeMs: 0,
        contentHash: 'content:dev',
      },
      passes: [{ id: 'world' }],
      draws: [],
    } satisfies RenderCommandBuffer;

    expect(__test__.selectClearColor(rcb)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('prefers the clear draw matching the first pass', () => {
    const rcb = {
      frame: {
        schemaVersion: 1,
        step: 0,
        simTimeMs: 0,
        contentHash: 'content:dev',
      },
      passes: [{ id: 'ui' }, { id: 'world' }],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0xff_00_00_ff,
        },
        {
          kind: 'clear',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_ff_00_ff,
        },
      ],
    } satisfies RenderCommandBuffer;

    expect(__test__.selectClearColor(rcb)).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });

  describe('createWebGpuRenderer', () => {
    function createStubWebGpuEnvironment(options?: {
      canvas?: Partial<HTMLCanvasElement> & { getContext?: unknown };
    }): {
      canvas: HTMLCanvasElement;
      context: GPUCanvasContext;
      adapter: GPUAdapter;
      device: GPUDevice;
      configure: ReturnType<typeof vi.fn>;
      beginRenderPass: ReturnType<typeof vi.fn>;
      submit: ReturnType<typeof vi.fn>;
    } {
      const configure = vi.fn();

      const passEncoder = { end: vi.fn() } as unknown as GPURenderPassEncoder;
      const beginRenderPass = vi.fn(() => passEncoder);

      const commandBuffer = {} as unknown as GPUCommandBuffer;
      const finish = vi.fn(() => commandBuffer);
      const commandEncoder = { beginRenderPass, finish } as unknown as GPUCommandEncoder;

      const submit = vi.fn();
      const queue = { submit } as unknown as GPUQueue;

      const deviceLost = new Promise<GPUDeviceLostInfo>(() => undefined);
      const device = {
        lost: deviceLost,
        queue,
        createCommandEncoder: vi.fn(() => commandEncoder),
      } as unknown as GPUDevice;

      const adapter = {
        features: { has: () => true },
        requestDevice: vi.fn(async () => device),
      } as unknown as GPUAdapter;

      const requestAdapter = vi.fn(async () => adapter);
      const getPreferredCanvasFormat = vi.fn(() => 'bgra8unorm' as GPUTextureFormat);
      setNavigator({ gpu: { requestAdapter, getPreferredCanvasFormat } } as unknown as Navigator);

      const view = {} as unknown as GPUTextureView;
      const texture = { createView: vi.fn(() => view) } as unknown as GPUTexture;
      const context = {
        configure,
        getCurrentTexture: vi.fn(() => texture),
      } as unknown as GPUCanvasContext;

      const canvas = {
        clientWidth: 100,
        clientHeight: 50,
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
        ...(options?.canvas ?? {}),
      } as unknown as HTMLCanvasElement;

      return { canvas, context, adapter, device, configure, beginRenderPass, submit };
    }

    it('throws when WebGPU is unavailable', async () => {
      setNavigator(undefined);

      const canvas = {} as unknown as HTMLCanvasElement;
      await expect(createWebGpuRenderer(canvas)).rejects.toBeInstanceOf(WebGpuNotSupportedError);
    });

    it('throws when an adapter cannot be acquired', async () => {
      const requestAdapter = vi.fn(async () => null);
      setNavigator({ gpu: { requestAdapter } } as unknown as Navigator);

      const canvas = {} as unknown as HTMLCanvasElement;
      await expect(createWebGpuRenderer(canvas)).rejects.toThrow('WebGPU adapter not found.');
    });

    it('throws when required features are missing', async () => {
      const requestDevice = vi.fn();
      const hasFeature = vi.fn(() => false);
      const adapter = {
        features: { has: hasFeature },
        requestDevice,
      } as unknown as GPUAdapter;

      const requestAdapter = vi.fn(async () => adapter);
      setNavigator({ gpu: { requestAdapter } } as unknown as Navigator);

      const requiredFeature = 'timestamp-query' as unknown as GPUFeatureName;
      const canvas = {} as unknown as HTMLCanvasElement;

      await expect(
        createWebGpuRenderer(canvas, { requiredFeatures: [requiredFeature] }),
      ).rejects.toThrow(`Required WebGPU feature not supported: ${requiredFeature}`);
      expect(hasFeature).toHaveBeenCalledWith(requiredFeature);
      expect(requestDevice).not.toHaveBeenCalled();
    });

    it('throws when a WebGPU canvas context cannot be acquired', async () => {
      const adapter = {
        features: { has: () => true },
        requestDevice: vi.fn(async () => ({} as unknown as GPUDevice)),
      } as unknown as GPUAdapter;

      const requestAdapter = vi.fn(async () => adapter);
      const getPreferredCanvasFormat = vi.fn(() => 'bgra8unorm' as GPUTextureFormat);
      setNavigator({ gpu: { requestAdapter, getPreferredCanvasFormat } } as unknown as Navigator);

      const canvas = {
        getContext: vi.fn(() => null),
      } as unknown as HTMLCanvasElement;

      await expect(createWebGpuRenderer(canvas)).rejects.toThrow(
        'Failed to acquire WebGPU canvas context.',
      );
    });

    it('configures the canvas context when resized and avoids redundant reconfiguration', async () => {
      setDevicePixelRatio(2);
      const { canvas, configure } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas, { alphaMode: 'premultiplied' });

      expect(canvas.width).toBe(200);
      expect(canvas.height).toBe(100);
      expect(configure).toHaveBeenCalledTimes(2);

      renderer.resize({ devicePixelRatio: 2 });
      expect(configure).toHaveBeenCalledTimes(2);
    });

    it('clears using the selected render command buffer clear color', async () => {
      const { canvas, beginRenderPass, submit } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: 1,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'world' }],
        draws: [
          {
            kind: 'clear',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            colorRgba: 0x18_2a_44_ff,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(beginRenderPass).toHaveBeenCalledTimes(1);
      const [renderPassDescriptor] = beginRenderPass.mock.calls[0] ?? [];
      expect(renderPassDescriptor).toMatchObject({
        colorAttachments: [
          {
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: __test__.colorRgbaToGpuColor(0x18_2a_44_ff),
          },
        ],
      });

      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('no-ops after dispose', async () => {
      const { canvas, beginRenderPass, submit } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);
      renderer.dispose();

      const rcb = {
        frame: {
          schemaVersion: 1,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'world' }],
        draws: [],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(beginRenderPass).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });
  });
});
