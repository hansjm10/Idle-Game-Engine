import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __test__,
  createWebGpuRenderer,
  WebGpuDeviceLostError,
  WebGpuNotSupportedError,
} from './webgpu-renderer.js';
import {
  compileViewModelToRenderCommandBuffer,
  RENDERER_CONTRACT_SCHEMA_VERSION,
  WORLD_FIXED_POINT_SCALE,
} from '@idle-engine/renderer-contract';
import type { AssetId, AssetManifest, RenderCommandBuffer } from '@idle-engine/renderer-contract';

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

  async function flushMicrotasks(maxTurns = 10): Promise<void> {
    for (let i = 0; i < maxTurns; i += 1) {
      await Promise.resolve();
    }
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
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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

  it('selects a clear draw even when the RCB has no passes', () => {
    const rcb = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 0,
        simTimeMs: 0,
        contentHash: 'content:dev',
      },
      passes: [],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x12_34_56_78,
        },
      ],
    } satisfies RenderCommandBuffer;

    expect(__test__.selectClearColor(rcb)).toEqual(__test__.colorRgbaToGpuColor(0x12_34_56_78));
  });

  it('derives external image sizes from common dimensions and defaults to 0', () => {
    expect(__test__.getExternalImageSize({} as unknown as GPUImageCopyExternalImageSource)).toEqual({
      width: 0,
      height: 0,
    });

    expect(
      __test__.getExternalImageSize(
        { naturalWidth: 10, naturalHeight: 20 } as unknown as GPUImageCopyExternalImageSource,
      ),
    ).toEqual({ width: 10, height: 20 });

    expect(
      __test__.getExternalImageSize(
        {
          width: Number.NaN,
          height: Infinity,
          videoWidth: 3.9,
          videoHeight: 4.1,
        } as unknown as GPUImageCopyExternalImageSource,
      ),
    ).toEqual({ width: 3, height: 4 });
  });

  describe('createWebGpuRenderer', () => {
    function createStubWebGpuEnvironment(options?: {
      canvas?: Partial<HTMLCanvasElement> & { getContext?: unknown };
      configureImplementation?: (configuration: GPUCanvasConfiguration) => void;
      includeGetPreferredCanvasFormat?: boolean;
      preferredCanvasFormat?: GPUTextureFormat;
      legacyPreferredFormat?: (adapter: GPUAdapter) => GPUTextureFormat;
    }): {
      canvas: HTMLCanvasElement;
      context: GPUCanvasContext;
      adapter: GPUAdapter;
      device: GPUDevice;
      configure: ReturnType<typeof vi.fn>;
      beginRenderPass: ReturnType<typeof vi.fn>;
      drawIndexed: ReturnType<typeof vi.fn>;
      setScissorRect: ReturnType<typeof vi.fn>;
      submit: ReturnType<typeof vi.fn>;
      writeBuffer: ReturnType<typeof vi.fn>;
      copyExternalImageToTexture: ReturnType<typeof vi.fn>;
      createBuffer: ReturnType<typeof vi.fn>;
      createTexture: ReturnType<typeof vi.fn>;
      getPreferredCanvasFormat?: ReturnType<typeof vi.fn>;
      getPreferredFormat?: ReturnType<typeof vi.fn>;
      resolveDeviceLost: (info: GPUDeviceLostInfo) => void;
    } {
      const configure = vi.fn(
        options?.configureImplementation ?? ((_configuration: GPUCanvasConfiguration) => undefined),
      );

      const drawIndexed = vi.fn();
      const setScissorRect = vi.fn();
      const passEncoder = {
        end: vi.fn(),
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        setScissorRect,
        drawIndexed,
      } as unknown as GPURenderPassEncoder;
      const beginRenderPass = vi.fn(() => passEncoder);

      const commandBuffer = {} as unknown as GPUCommandBuffer;
      const finish = vi.fn(() => commandBuffer);
      const commandEncoder = { beginRenderPass, finish } as unknown as GPUCommandEncoder;

      const submit = vi.fn();
      const writeBuffer = vi.fn();
      const copyExternalImageToTexture = vi.fn();
      const queue = { submit, writeBuffer, copyExternalImageToTexture } as unknown as GPUQueue;

      const createBuffer = vi.fn(
        () =>
          ({
            destroy: vi.fn(),
          }) as unknown as GPUBuffer,
      );
      const createTexture = vi.fn(
        () =>
          ({
            createView: vi.fn(() => ({} as unknown as GPUTextureView)),
            destroy: vi.fn(),
          }) as unknown as GPUTexture,
      );

      let resolveDeviceLost: (info: GPUDeviceLostInfo) => void = () => undefined;
      const deviceLost = new Promise<GPUDeviceLostInfo>((resolve) => {
        resolveDeviceLost = resolve;
      });
      const device = {
        lost: deviceLost,
        queue,
        createCommandEncoder: vi.fn(() => commandEncoder),
        createShaderModule: vi.fn(() => ({} as unknown as GPUShaderModule)),
        createBindGroupLayout: vi.fn(() => ({} as unknown as GPUBindGroupLayout)),
        createPipelineLayout: vi.fn(() => ({} as unknown as GPUPipelineLayout)),
        createRenderPipeline: vi.fn(() => ({} as unknown as GPURenderPipeline)),
        createSampler: vi.fn(() => ({} as unknown as GPUSampler)),
        createBuffer,
        createBindGroup: vi.fn(() => ({} as unknown as GPUBindGroup)),
        createTexture,
      } as unknown as GPUDevice;

      const adapter = {
        features: { has: () => true },
        requestDevice: vi.fn(async () => device),
      } as unknown as GPUAdapter;

      const requestAdapter = vi.fn(async () => adapter);
      const gpu = { requestAdapter } as unknown as Record<string, unknown>;
      const getPreferredCanvasFormat =
        options?.includeGetPreferredCanvasFormat === false
          ? undefined
          : vi.fn(() => options?.preferredCanvasFormat ?? ('bgra8unorm' as GPUTextureFormat));
      if (getPreferredCanvasFormat) {
        gpu.getPreferredCanvasFormat = getPreferredCanvasFormat;
      }
      setNavigator({ gpu } as unknown as Navigator);

      const view = {} as unknown as GPUTextureView;
      const texture = { createView: vi.fn(() => view) } as unknown as GPUTexture;
      const getPreferredFormat = options?.legacyPreferredFormat
        ? vi.fn(options.legacyPreferredFormat)
        : undefined;
      const context = {
        configure,
        getCurrentTexture: vi.fn(() => texture),
        ...(getPreferredFormat ? { getPreferredFormat } : {}),
      } as unknown as GPUCanvasContext;

      const canvas = {
        clientWidth: 100,
        clientHeight: 50,
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
        ...(options?.canvas ?? {}),
      } as unknown as HTMLCanvasElement;

      return {
        canvas,
        context,
        adapter,
        device,
        configure,
        beginRenderPass,
        drawIndexed,
        setScissorRect,
        submit,
        writeBuffer,
        copyExternalImageToTexture,
        createBuffer,
        createTexture,
        getPreferredCanvasFormat,
        getPreferredFormat,
        resolveDeviceLost,
      };
    }

    function getWriteBufferFloat32Payload(call: unknown[]): Float32Array | undefined {
      if (call.length < 3) {
        return undefined;
      }

      const data = call[2];
      const dataOffset = typeof call[3] === 'number' ? call[3] : 0;
      const size = typeof call[4] === 'number' ? call[4] : undefined;

      if (data instanceof ArrayBuffer) {
        const byteLength = size ?? data.byteLength - dataOffset;
        return new Float32Array(data, dataOffset, byteLength / Float32Array.BYTES_PER_ELEMENT);
      }

      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        const byteLength = size ?? view.byteLength - dataOffset;
        return new Float32Array(
          view.buffer,
          view.byteOffset + dataOffset,
          byteLength / Float32Array.BYTES_PER_ELEMENT,
        );
      }

      return undefined;
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

    it('passes requiredFeatures through to requestDevice', async () => {
      const { canvas, adapter } = createStubWebGpuEnvironment();

      const requiredFeature = 'timestamp-query' as unknown as GPUFeatureName;
      await createWebGpuRenderer(canvas, {
        requiredFeatures: [requiredFeature],
        deviceDescriptor: {
          requiredFeatures: ['depth-clip-control'] as unknown as GPUFeatureName[],
        },
      });

      const requestDevice = (adapter as unknown as { requestDevice: ReturnType<typeof vi.fn> })
        .requestDevice;
      expect(requestDevice).toHaveBeenCalledTimes(1);
      expect(requestDevice.mock.calls[0]?.[0]).toMatchObject({
        requiredFeatures: [requiredFeature],
      });
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

    it('uses gpu.getPreferredCanvasFormat when available', async () => {
      const preferredCanvasFormat = 'rgba8unorm' as GPUTextureFormat;
      const { canvas, configure, getPreferredCanvasFormat } = createStubWebGpuEnvironment({
        preferredCanvasFormat,
      });

      await createWebGpuRenderer(canvas);

      expect(getPreferredCanvasFormat).toHaveBeenCalledTimes(1);
      expect(configure).toHaveBeenCalledTimes(2);
      expect(configure.mock.calls[0]?.[0]).toMatchObject({ format: preferredCanvasFormat });
    });

    it('falls back to legacy context.getPreferredFormat when getPreferredCanvasFormat is unavailable', async () => {
      const legacyFormat = 'rgba16float' as GPUTextureFormat;
      const { canvas, adapter, configure, getPreferredFormat } = createStubWebGpuEnvironment({
        includeGetPreferredCanvasFormat: false,
        legacyPreferredFormat: () => legacyFormat,
      });

      await createWebGpuRenderer(canvas);

      expect(getPreferredFormat).toHaveBeenCalledTimes(1);
      expect(getPreferredFormat).toHaveBeenCalledWith(adapter);
      expect(configure.mock.calls[0]?.[0]).toMatchObject({ format: legacyFormat });
    });

    it('falls back to bgra8unorm when no preferred format APIs are available', async () => {
      const { canvas, configure } = createStubWebGpuEnvironment({
        includeGetPreferredCanvasFormat: false,
      });

      await createWebGpuRenderer(canvas);

      expect(configure.mock.calls[0]?.[0]).toMatchObject({ format: 'bgra8unorm' });
    });

    it('wraps context.configure failures with WebGpuNotSupportedError including attempted format', async () => {
      const preferredFormat = 'rgba8unorm' as GPUTextureFormat;
      const configureError = new Error('configure failed');
      const { canvas } = createStubWebGpuEnvironment({
        configureImplementation: () => {
          throw configureError;
        },
      });

      await expect(
        createWebGpuRenderer(canvas, { preferredFormats: [preferredFormat] }),
      ).rejects.toBeInstanceOf(WebGpuNotSupportedError);
      await expect(
        createWebGpuRenderer(canvas, { preferredFormats: [preferredFormat] }),
      ).rejects.toThrow(`format: ${preferredFormat}`);
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

    it('throws when worldFixedPointScale is invalid', async () => {
      const { canvas } = createStubWebGpuEnvironment();

      await expect(createWebGpuRenderer(canvas, { worldFixedPointScale: 0 })).rejects.toThrow(
        'WebGPU renderer expected worldFixedPointScale to be a positive number.',
      );
    });

    it('clears using the selected render command buffer clear color', async () => {
      const { canvas, beginRenderPass, submit } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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

    it('throws when rendering image draws without a loaded sprite atlas', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'world' }],
        draws: [
          {
            kind: 'image',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            assetId: 'sprite:missing' as AssetId,
            x: 10 * WORLD_FIXED_POINT_SCALE,
            y: 20 * WORLD_FIXED_POINT_SCALE,
            width: 30 * WORLD_FIXED_POINT_SCALE,
            height: 40 * WORLD_FIXED_POINT_SCALE,
          },
        ],
      } satisfies RenderCommandBuffer;

      expect(() => renderer.render(rcb)).toThrow('No sprite atlas loaded');
    });

    it('throws when a manifest contains a font but loadFont is not provided', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'font:demo' as AssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));

      await expect(renderer.loadAssets(manifest, { loadImage })).rejects.toThrow(
        'assets.loadFont is not provided',
      );
    });

    it('throws on duplicate AssetIds in an AssetManifest', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [
          { id: 'sprite:dup' as AssetId, kind: 'image', contentHash: 'hash:1' },
          { id: 'sprite:dup' as AssetId, kind: 'spriteSheet', contentHash: 'hash:2' },
        ],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));

      await expect(renderer.loadAssets(manifest, { loadImage })).rejects.toThrow(
        'AssetManifest contains duplicate AssetId',
      );
      expect(loadImage).not.toHaveBeenCalled();
    });

    it('throws when loaded atlas images have invalid dimensions', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:bad' as AssetId, kind: 'image', contentHash: 'hash:bad' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 0, height: 0 } as unknown as GPUImageCopyExternalImageSource));

      await expect(renderer.loadAssets(manifest, { loadImage })).rejects.toThrow(
        'has invalid dimensions 0x0',
      );
    });

    it('loads image assets sorted by AssetId and exposes atlas state', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      expect(renderer.atlasLayout).toBeUndefined();
      expect(renderer.atlasLayoutHash).toBeUndefined();

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [
          { id: 'sprite:b' as AssetId, kind: 'image', contentHash: 'hash:b' },
          { id: 'sprite:a' as AssetId, kind: 'image', contentHash: 'hash:a' },
        ],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));

      const state = await renderer.loadAssets(manifest, { loadImage });

      expect(loadImage.mock.calls.map((call) => call[0])).toEqual(['sprite:a', 'sprite:b']);
      expect(renderer.atlasLayout).toBeDefined();
      expect(renderer.atlasLayoutHash).toBeDefined();
      expect(state.layoutHash).toBe(renderer.atlasLayoutHash);
    });

    it('destroys the previous atlas texture when loadAssets is called again', async () => {
      const { canvas, createTexture } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(
        async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource),
      );

      await renderer.loadAssets(manifest, { loadImage });
      await renderer.loadAssets(manifest, { loadImage });

      expect(createTexture).toHaveBeenCalledTimes(2);

      const firstTexture = createTexture.mock.results[0]?.value as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      };
      const secondTexture = createTexture.mock.results[1]?.value as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      };
      if (!firstTexture || !secondTexture) {
        throw new Error('Expected two atlas textures to be created.');
      }

      expect(firstTexture.destroy).toHaveBeenCalledTimes(1);
      expect(secondTexture.destroy).not.toHaveBeenCalled();
    });

    it('throws when rendering text draws without loaded bitmap fonts', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      await renderer.loadAssets(manifest, { loadImage });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'A',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId: 'font:missing' as AssetId,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      expect(() => renderer.render(rcb)).toThrow('No bitmap fonts loaded');
    });

    it('uploads an atlas and draws sprite instances', async () => {
      const {
        canvas,
        copyExternalImageToTexture,
        drawIndexed,
        writeBuffer,
      } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [
          { id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' },
        ],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));

      await renderer.loadAssets(
        manifest,
        { loadImage },
        { maxAtlasSizePx: 64, paddingPx: 0, powerOfTwo: true },
      );

      expect(loadImage).toHaveBeenCalledWith('sprite:demo', 'hash:demo');
      expect(copyExternalImageToTexture).toHaveBeenCalledTimes(1);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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
            colorRgba: 0x00_00_00_ff,
          },
          {
            kind: 'image',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
            assetId: 'sprite:demo' as AssetId,
            x: 10 * WORLD_FIXED_POINT_SCALE,
            y: 20 * WORLD_FIXED_POINT_SCALE,
            width: 30 * WORLD_FIXED_POINT_SCALE,
            height: 40 * WORLD_FIXED_POINT_SCALE,
            tintRgba: 0x12_34_56_80,
          },
          {
            kind: 'image',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
            assetId: 'sprite:demo' as AssetId,
            x: 50 * WORLD_FIXED_POINT_SCALE,
            y: 60 * WORLD_FIXED_POINT_SCALE,
            width: 70 * WORLD_FIXED_POINT_SCALE,
            height: 80 * WORLD_FIXED_POINT_SCALE,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 2, 0, 0, 0);

      const instanceBufferWrite = writeBuffer.mock.calls.find((call) => {
        const instances = getWriteBufferFloat32Payload(call);
        if (!instances || instances.byteLength !== 96) {
          return false;
        }

        return (
          instances[0] === 10 &&
          instances[1] === 20 &&
          instances[2] === 30 &&
          instances[3] === 40
        );
      });

      expect(instanceBufferWrite).toBeDefined();
      if (!instanceBufferWrite) {
        throw new Error('Expected an instance buffer upload for sprite instances.');
      }
      const instances = getWriteBufferFloat32Payload(instanceBufferWrite);
      if (!instances) {
        throw new Error('Expected sprite instance buffer payload to be readable.');
      }

      expect(instances.slice(8, 12)).toEqual(
        new Float32Array([0x12 / 255, 0x34 / 255, 0x56 / 255, 0x80 / 255]),
      );
      expect(instances.slice(20, 24)).toEqual(new Float32Array([1, 1, 1, 1]));
    });

    it('reuses the quad instance upload buffer across renders', async () => {
      const { canvas, writeBuffer } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            colorRgba: 0xff_00_00_ff,
          },
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
            x: 5,
            y: 6,
            width: 7,
            height: 8,
            colorRgba: 0x00_ff_00_ff,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);
      renderer.render(rcb);

      const instanceWrites = writeBuffer.mock.calls.filter((call) => call[2] instanceof Float32Array);
      expect(instanceWrites).toHaveLength(2);

      const firstWrite = instanceWrites[0];
      const secondWrite = instanceWrites[1];
      if (!firstWrite || !secondWrite) {
        throw new Error('Expected quad instance uploads to be recorded.');
      }

      const firstPayload = firstWrite[2] as Float32Array;
      const secondPayload = secondWrite[2] as Float32Array;
      const firstSize = firstWrite[4] as number;
      const secondSize = secondWrite[4] as number;

      expect(firstSize).toBe(96);
      expect(secondSize).toBe(96);
      expect(firstPayload.byteLength).toBeGreaterThan(firstSize);
      expect(secondPayload).toBe(firstPayload);
    });

    it('flushes quad batches when encountering unknown draw kinds', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            colorRgba: 0xff_00_00_ff,
          },
          {
            kind: 'future-draw',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          },
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
            x: 5,
            y: 6,
            width: 7,
            height: 8,
            colorRgba: 0x00_ff_00_ff,
          },
        ],
      } as unknown as RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(2);
      expect(drawIndexed).toHaveBeenNthCalledWith(1, 6, 1, 0, 0, 0);
      expect(drawIndexed).toHaveBeenNthCalledWith(2, 6, 1, 0, 0, 0);
    });

    it('preserves quad instance data when the batch buffer grows', async () => {
      const { canvas, drawIndexed, writeBuffer } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const draws: RenderCommandBuffer['draws'] = Array.from({ length: 22 }, (_value, index) => ({
        kind: 'rect',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: index },
        x: index,
        y: 0,
        width: 1,
        height: 1,
        colorRgba: 0xff_ff_ff_ff,
      }));

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws,
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 22, 0, 0, 0);

      const instanceWrites = writeBuffer.mock.calls.filter((call) => call[2] instanceof Float32Array);
      expect(instanceWrites).toHaveLength(1);

      const instanceWrite = instanceWrites[0];
      if (!instanceWrite) {
        throw new Error('Expected a quad instance upload to be recorded.');
      }

      const usedBytes = instanceWrite[4] as number;
      expect(usedBytes).toBe(22 * 48);

      const payload = instanceWrite[2] as Float32Array;
      expect(payload.byteLength).toBeGreaterThan(usedBytes);

      const instances = getWriteBufferFloat32Payload(instanceWrite);
      if (!instances) {
        throw new Error('Expected quad instance buffer payload to be readable.');
      }

      expect(instances.length).toBe((22 * 48) / Float32Array.BYTES_PER_ELEMENT);
      expect(instances[0]).toBe(0);
      expect(instances[12]).toBe(1);
      expect(instances[120]).toBe(10);
      expect(instances[252]).toBe(21);
    });

    it('destroys the previous GPU instance buffer when growing', async () => {
      const { canvas, createBuffer } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const frame: RenderCommandBuffer['frame'] = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 0,
        simTimeMs: 0,
        contentHash: 'content:dev',
      };

      const rcbSmall = {
        frame,
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            colorRgba: 0xff_ff_ff_ff,
          },
        ],
      } satisfies RenderCommandBuffer;

      const rcbLarge = {
        frame,
        passes: [{ id: 'ui' }],
        draws: Array.from({ length: 30 }, (_value, index) => ({
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: index },
          x: index,
          y: 0,
          width: 1,
          height: 1,
          colorRgba: 0xff_ff_ff_ff,
        })),
      } satisfies RenderCommandBuffer;

      renderer.render(rcbSmall);
      renderer.render(rcbLarge);

      expect(createBuffer).toHaveBeenCalledTimes(5);

      const firstInstanceBuffer = createBuffer.mock.results[3]?.value as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      };
      const secondInstanceBuffer = createBuffer.mock.results[4]?.value as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      };
      if (!firstInstanceBuffer || !secondInstanceBuffer) {
        throw new Error('Expected two instance buffer allocations.');
      }

      expect(firstInstanceBuffer.destroy).toHaveBeenCalledTimes(1);
      expect(secondInstanceBuffer.destroy).not.toHaveBeenCalled();
    });

    it('renders render-compiler output (world pass fixed-point coordinates)', async () => {
      const { canvas, writeBuffer, drawIndexed } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(
        async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource),
      );
      await renderer.loadAssets(
        manifest,
        { loadImage },
        { maxAtlasSizePx: 64, paddingPx: 0, powerOfTwo: true },
      );

      const rcb = compileViewModelToRenderCommandBuffer({
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        scene: {
          camera: { x: 0, y: 0, zoom: 1 },
          sprites: [
            {
              id: 'sprite',
              assetId: 'sprite:demo' as AssetId,
              x: 10,
              y: 20,
              z: 0,
              width: 30,
              height: 40,
            },
          ],
        },
        ui: {
          nodes: [],
        },
      });

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);

      const instanceBufferWrite = writeBuffer.mock.calls.find((call) => {
        const instances = getWriteBufferFloat32Payload(call);
        if (!instances || instances.byteLength !== 48) {
          return false;
        }

        return (
          instances[0] === 10 &&
          instances[1] === 20 &&
          instances[2] === 30 &&
          instances[3] === 40
        );
      });

      expect(instanceBufferWrite).toBeDefined();
      if (!instanceBufferWrite) {
        throw new Error('Expected an instance buffer upload for sprite instances.');
      }

      const instances = getWriteBufferFloat32Payload(instanceBufferWrite);
      if (!instances) {
        throw new Error('Expected sprite instance buffer payload to be readable.');
      }
      expect(instances.slice(8, 12)).toEqual(new Float32Array([1, 1, 1, 1]));
    });

    it('throws when image draws reference an AssetId missing from the loaded atlas', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      await renderer.loadAssets(manifest, { loadImage }, { maxAtlasSizePx: 64, paddingPx: 0, powerOfTwo: true });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'world' }],
        draws: [
          {
            kind: 'image',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            assetId: 'sprite:unknown' as AssetId,
            x: 0,
            y: 0,
            width: 10 * WORLD_FIXED_POINT_SCALE,
            height: 10 * WORLD_FIXED_POINT_SCALE,
          },
        ],
      } satisfies RenderCommandBuffer;

      expect(() => renderer.render(rcb)).toThrow('Atlas missing UVs for AssetId');
    });

    it('draws rect instances without requiring a loaded atlas', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            colorRgba: 0xff_00_00_ff,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);
    });

    it('rejects bitmap fonts with invalid baseFontSizePx', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:bad' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 0,
        lineHeightPx: 8,
        glyphs: [],
      }));

      await expect(renderer.loadAssets(manifest, { loadImage, loadFont })).rejects.toThrow(
        'invalid baseFontSizePx',
      );
    });

    it('rejects bitmap fonts with invalid lineHeightPx', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:bad' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 0,
        glyphs: [],
      }));

      await expect(renderer.loadAssets(manifest, { loadImage, loadFont })).rejects.toThrow(
        'invalid lineHeightPx',
      );
    });

    it('rejects bitmap fonts containing duplicate glyph codePoints', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:dup' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [
          {
            codePoint: 0x41,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
          {
            codePoint: 0x41,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
        ],
      }));

      await expect(renderer.loadAssets(manifest, { loadImage, loadFont })).rejects.toThrow(
        'duplicate glyph codePoint',
      );
    });

    it.each([
      {
        name: 'invalid codePoints',
        glyph: {
          codePoint: -1,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          xOffsetPx: 0,
          yOffsetPx: 0,
          xAdvancePx: 8,
        },
        expectedMessage: 'invalid glyph codePoint',
      },
      {
        name: 'non-finite bounds',
        glyph: {
          codePoint: 0x41,
          x: 0,
          y: 0,
          width: Number.NaN,
          height: 8,
          xOffsetPx: 0,
          yOffsetPx: 0,
          xAdvancePx: 8,
        },
        expectedMessage: 'has non-finite bounds',
      },
      {
        name: 'negative sizes',
        glyph: {
          codePoint: 0x41,
          x: 0,
          y: 0,
          width: -1,
          height: 8,
          xOffsetPx: 0,
          yOffsetPx: 0,
          xAdvancePx: 8,
        },
        expectedMessage: 'has negative size',
      },
      {
        name: 'bounds exceeding the font image',
        glyph: {
          codePoint: 0x41,
          x: 7,
          y: 0,
          width: 2,
          height: 8,
          xOffsetPx: 0,
          yOffsetPx: 0,
          xAdvancePx: 8,
        },
        expectedMessage: 'bounds exceed atlas image',
      },
      {
        name: 'non-finite metrics',
        glyph: {
          codePoint: 0x41,
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          xOffsetPx: 0,
          yOffsetPx: 0,
          xAdvancePx: Number.NaN,
        },
        expectedMessage: 'has non-finite metrics',
      },
    ])('rejects bitmap font glyphs with $name', async ({ glyph, expectedMessage }) => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:bad-glyph' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [glyph],
      }));

      await expect(renderer.loadAssets(manifest, { loadImage, loadFont })).rejects.toThrow(expectedMessage);
    });

    it('renders bitmap text as sprite instances', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:demo' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [
          { id: fontAssetId, kind: 'font', contentHash: 'hash:font' },
        ],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 32, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [
          {
            codePoint: 0x41,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
          {
            codePoint: 0x42,
            x: 8,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
          {
            codePoint: 0x3f,
            x: 16,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
          {
            codePoint: 0x20,
            x: 24,
            y: 0,
            width: 0,
            height: 0,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
        ],
        fallbackCodePoint: 0x3f,
      }));

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      expect(loadFont).toHaveBeenCalledWith(fontAssetId, 'hash:font');

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'AB',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 2, 0, 0, 0);
    });

    it('defaults to the lexicographically-first bitmap font when fontAssetId is omitted', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetIdA = 'font:a' as AssetId;
      const fontAssetIdB = 'font:b' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [
          { id: fontAssetIdB, kind: 'font', contentHash: 'hash:font:b' },
          { id: fontAssetIdA, kind: 'font', contentHash: 'hash:font:a' },
        ],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async (assetId: AssetId) => {
        if (assetId === fontAssetIdA) {
          return {
            image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
            baseFontSizePx: 8,
            lineHeightPx: 8,
            glyphs: [
              {
                codePoint: 0x41,
                x: 0,
                y: 0,
                width: 8,
                height: 8,
                xOffsetPx: 0,
                yOffsetPx: 0,
                xAdvancePx: 8,
              },
            ],
          };
        }

        return {
          image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
          baseFontSizePx: 8,
          lineHeightPx: 8,
          glyphs: [],
        };
      });

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'A',
            colorRgba: 0xff_ff_ff_ff,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);
    });

    it('falls back to the first available glyph when no fallback glyph is present', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:fallback' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [
          {
            codePoint: 0x41,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
        ],
      }));

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'Z',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);
    });

    it('throws when a text draw has an invalid fontSizePx', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:demo' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [],
      }));

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'A',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId,
            fontSizePx: 0,
          },
        ],
      } satisfies RenderCommandBuffer;

      expect(() => renderer.render(rcb)).toThrow('Invalid fontSizePx');
      expect(drawIndexed).not.toHaveBeenCalled();
    });

    it('handles control characters and no-ops when bitmap fonts contain no glyphs', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:empty' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [],
      }));

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'A\rB\n\tC',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).not.toHaveBeenCalled();
    });

    it('no-ops when a text draw has an empty string payload', async () => {
      const { canvas, drawIndexed, writeBuffer } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:demo' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [
          {
            codePoint: 0x41,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
        ],
      }));

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: '',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).not.toHaveBeenCalled();
      expect(writeBuffer.mock.calls.filter((call) => call[2] instanceof Float32Array)).toHaveLength(0);
    });

    it('throws when a text draw has a blank fontAssetId', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:demo' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [
          {
            codePoint: 0x41,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
        ],
      }));

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'A',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId: '' as AssetId,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      expect(() => renderer.render(rcb)).toThrow(
        'Text draw missing fontAssetId and no default font is available.',
      );
      expect(drawIndexed).not.toHaveBeenCalled();
    });

    it('throws when a text draw references an unknown fontAssetId', async () => {
      const { canvas } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const fontAssetId = 'font:demo' as AssetId;
      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));
      const loadFont = vi.fn(async () => ({
        image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
        baseFontSizePx: 8,
        lineHeightPx: 8,
        glyphs: [
          {
            codePoint: 0x41,
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            xOffsetPx: 0,
            yOffsetPx: 0,
            xAdvancePx: 8,
          },
        ],
      }));

      await renderer.loadAssets(manifest, { loadImage, loadFont });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'text',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10,
            y: 20,
            text: 'A',
            colorRgba: 0xff_ff_ff_ff,
            fontAssetId: 'font:unknown' as AssetId,
            fontSizePx: 8,
          },
        ],
      } satisfies RenderCommandBuffer;

      expect(() => renderer.render(rcb)).toThrow('Unknown fontAssetId');
    });

    it('applies scissorPush/scissorPop with devicePixelRatio scaling', async () => {
      setDevicePixelRatio(2);
      const { canvas, drawIndexed, setScissorRect } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'scissorPush',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 1,
            y: 2,
            width: 3,
            height: 4,
          },
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            colorRgba: 0xff_00_00_ff,
          },
          {
            kind: 'scissorPop',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
          },
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            colorRgba: 0x00_ff_00_ff,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(setScissorRect.mock.calls).toEqual([
        [0, 0, 200, 100],
        [2, 4, 6, 8],
        [0, 0, 200, 100],
      ]);

      expect(drawIndexed).toHaveBeenCalledTimes(2);
      expect(drawIndexed).toHaveBeenNthCalledWith(1, 6, 1, 0, 0, 0);
      expect(drawIndexed).toHaveBeenNthCalledWith(2, 6, 1, 0, 0, 0);
    });

    it('skips draws when the current scissor rect is empty', async () => {
      const { canvas, drawIndexed } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'scissorPush',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 0,
            y: 0,
            width: 0,
            height: 0,
          },
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            colorRgba: 0xff_00_00_ff,
          },
          {
            kind: 'scissorPop',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
          },
          {
            kind: 'rect',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            colorRgba: 0x00_ff_00_ff,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(drawIndexed).toHaveBeenCalledTimes(1);
      expect(drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);
    });

    it('applies scissorPush/scissorPop for world draws using the world camera', async () => {
      setDevicePixelRatio(2);
      const { canvas, drawIndexed, setScissorRect } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);
      renderer.setWorldCamera({ x: 10, y: 20, zoom: 2 });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'world' }],
        draws: [
          {
            kind: 'scissorPush',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 11 * WORLD_FIXED_POINT_SCALE,
            y: 22 * WORLD_FIXED_POINT_SCALE,
            width: 3 * WORLD_FIXED_POINT_SCALE,
            height: 4 * WORLD_FIXED_POINT_SCALE,
          },
          {
            kind: 'rect',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
            x: 0,
            y: 0,
            width: 1 * WORLD_FIXED_POINT_SCALE,
            height: 1 * WORLD_FIXED_POINT_SCALE,
            colorRgba: 0xff_00_00_ff,
          },
          {
            kind: 'scissorPop',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
          },
          {
            kind: 'rect',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
            x: 0,
            y: 0,
            width: 1 * WORLD_FIXED_POINT_SCALE,
            height: 1 * WORLD_FIXED_POINT_SCALE,
            colorRgba: 0x00_ff_00_ff,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(setScissorRect.mock.calls).toEqual([
        [0, 0, 200, 100],
        [4, 8, 12, 16],
        [0, 0, 200, 100],
      ]);

      expect(drawIndexed).toHaveBeenCalledTimes(2);
      expect(drawIndexed).toHaveBeenNthCalledWith(1, 6, 1, 0, 0, 0);
      expect(drawIndexed).toHaveBeenNthCalledWith(2, 6, 1, 0, 0, 0);
    });

    it('invokes onDeviceLost and no-ops render/resize after device loss', async () => {
      const { canvas, beginRenderPass, submit, configure, resolveDeviceLost } =
        createStubWebGpuEnvironment();
      const onDeviceLost = vi.fn();

      const renderer = await createWebGpuRenderer(canvas, { onDeviceLost });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 0,
          simTimeMs: 0,
          contentHash: 'content:dev',
        },
        passes: [{ id: 'world' }],
        draws: [],
      } satisfies RenderCommandBuffer;

      beginRenderPass.mockClear();
      submit.mockClear();
      configure.mockClear();

      renderer.render(rcb);
      expect(beginRenderPass).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);

      resolveDeviceLost({ message: 'lost', reason: 'unknown' } as unknown as GPUDeviceLostInfo);
      await flushMicrotasks();

      expect(onDeviceLost).toHaveBeenCalledTimes(1);
      const [deviceLostError] = onDeviceLost.mock.calls[0] ?? [];
      expect(deviceLostError).toBeInstanceOf(WebGpuDeviceLostError);
      expect(deviceLostError).toMatchObject({ reason: 'unknown' });

      beginRenderPass.mockClear();
      submit.mockClear();
      configure.mockClear();

      renderer.render(rcb);
      renderer.resize({ devicePixelRatio: 2 });

      expect(beginRenderPass).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(configure).not.toHaveBeenCalled();
    });

    it('does not invoke onDeviceLost after dispose', async () => {
      const { canvas, resolveDeviceLost } = createStubWebGpuEnvironment();
      const onDeviceLost = vi.fn();

      const renderer = await createWebGpuRenderer(canvas, { onDeviceLost });
      renderer.dispose();

      resolveDeviceLost({ message: 'lost', reason: 'unknown' } as unknown as GPUDeviceLostInfo);
      await flushMicrotasks();

      expect(onDeviceLost).not.toHaveBeenCalled();
    });

    it('rejects loadAssets after device loss', async () => {
      const { canvas, resolveDeviceLost } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      resolveDeviceLost({ message: 'lost', reason: 'unknown' } as unknown as GPUDeviceLostInfo);
      await flushMicrotasks();

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
      } satisfies AssetManifest;
      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));

      await expect(renderer.loadAssets(manifest, { loadImage })).rejects.toThrow('WebGPU device is lost.');
    });

    it('swallows failures thrown by onDeviceLost', async () => {
      const unhandledRejection = vi.fn();
      process.on('unhandledRejection', unhandledRejection);

      try {
        const { canvas, resolveDeviceLost } = createStubWebGpuEnvironment();
        const onDeviceLost = vi.fn(() => {
          throw new Error('boom');
        });

        await createWebGpuRenderer(canvas, { onDeviceLost });

        resolveDeviceLost({ message: 'lost', reason: 'unknown' } as unknown as GPUDeviceLostInfo);
        await flushMicrotasks();

        expect(onDeviceLost).toHaveBeenCalledTimes(1);
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandledRejection);
      }
    });

    it('no-ops after dispose', async () => {
      const { canvas, beginRenderPass, submit } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);
      renderer.dispose();

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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

    it('rejects loadAssets after dispose', async () => {
      const { canvas } = createStubWebGpuEnvironment();

      const renderer = await createWebGpuRenderer(canvas);
      renderer.dispose();

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
      } satisfies AssetManifest;
      const loadImage = vi.fn(async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource));

      await expect(renderer.loadAssets(manifest, { loadImage })).rejects.toThrow(
        'WebGPU renderer is disposed.',
      );
    });

    it('destroys owned GPU textures and buffers on dispose', async () => {
      const { canvas, createBuffer, createTexture } = createStubWebGpuEnvironment();
      const renderer = await createWebGpuRenderer(canvas);

      const manifest = {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
      } satisfies AssetManifest;

      const loadImage = vi.fn(
        async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource),
      );
      await renderer.loadAssets(manifest, { loadImage }, { maxAtlasSizePx: 64, paddingPx: 0 });

      const rcb = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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
            colorRgba: 0x00_00_00_ff,
          },
          {
            kind: 'image',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
            assetId: 'sprite:demo' as AssetId,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
      } satisfies RenderCommandBuffer;

      renderer.render(rcb);

      expect(createTexture).toHaveBeenCalledTimes(1);
      expect(createBuffer).toHaveBeenCalledTimes(4);

      const atlasTexture = createTexture.mock.results[0]?.value as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      };
      if (!atlasTexture) {
        throw new Error('Expected an atlas texture to be created.');
      }

      const buffers = createBuffer.mock.results.map((result) => result.value as unknown as {
        destroy: ReturnType<typeof vi.fn>;
      });

      renderer.dispose();

      expect(atlasTexture.destroy).toHaveBeenCalledTimes(1);
      for (const buffer of buffers) {
        expect(buffer.destroy).toHaveBeenCalledTimes(1);
      }

      renderer.dispose();

      expect(atlasTexture.destroy).toHaveBeenCalledTimes(1);
      for (const buffer of buffers) {
        expect(buffer.destroy).toHaveBeenCalledTimes(1);
      }
    });
  });
});
