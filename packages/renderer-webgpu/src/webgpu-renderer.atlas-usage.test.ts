import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import type { AssetId, AssetManifest } from '@idle-engine/renderer-contract';
import { createWebGpuRenderer } from './webgpu-renderer.js';

describe('renderer-webgpu atlas usage', () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function setNavigator(value: unknown): void {
    Object.defineProperty(globalThis, 'navigator', {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  function createStubWebGpuEnvironment(): {
    canvas: HTMLCanvasElement;
    createTexture: ReturnType<typeof vi.fn>;
  } {
    const deviceLost = new Promise<GPUDeviceLostInfo>(() => undefined);

    const queue = {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
    } as unknown as GPUQueue;

    const createTexture = vi.fn(
      () =>
        ({
          createView: vi.fn(() => ({} as unknown as GPUTextureView)),
          destroy: vi.fn(),
        }) as unknown as GPUTexture,
    );

    const device = {
      lost: deviceLost,
      queue,
      createShaderModule: vi.fn(() => ({} as unknown as GPUShaderModule)),
      createBindGroupLayout: vi.fn(() => ({} as unknown as GPUBindGroupLayout)),
      createPipelineLayout: vi.fn(() => ({} as unknown as GPUPipelineLayout)),
      createRenderPipeline: vi.fn(() => ({} as unknown as GPURenderPipeline)),
      createSampler: vi.fn(() => ({} as unknown as GPUSampler)),
      createBuffer: vi.fn(
        () =>
          ({
            destroy: vi.fn(),
          }) as unknown as GPUBuffer,
      ),
      createBindGroup: vi.fn(() => ({} as unknown as GPUBindGroup)),
      createTexture,
    } as unknown as GPUDevice;

    const adapter = {
      features: { has: () => true },
      requestDevice: vi.fn(async () => device),
    } as unknown as GPUAdapter;

    const requestAdapter = vi.fn(async () => adapter);
    const gpu = { requestAdapter, getPreferredCanvasFormat: () => 'bgra8unorm' as GPUTextureFormat };
    setNavigator({ gpu } as unknown as Navigator);

    const context = {
      configure: vi.fn(),
    } as unknown as GPUCanvasContext;

    const canvas = {
      clientWidth: 1,
      clientHeight: 1,
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;

    return { canvas, createTexture };
  }

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      delete (globalThis as unknown as { navigator?: unknown }).navigator;
    }
  });

  it('creates the atlas texture with COPY_DST | RENDER_ATTACHMENT | TEXTURE_BINDING', async () => {
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

    const copyDstUsage =
      (globalThis as unknown as { GPUTextureUsage?: { COPY_DST: number } }).GPUTextureUsage
        ?.COPY_DST ?? 2;
    const textureBindingUsage =
      (globalThis as unknown as { GPUTextureUsage?: { TEXTURE_BINDING: number } }).GPUTextureUsage
        ?.TEXTURE_BINDING ?? 4;
    const renderAttachmentUsage =
      (globalThis as unknown as { GPUTextureUsage?: { RENDER_ATTACHMENT: number } }).GPUTextureUsage
        ?.RENDER_ATTACHMENT ?? 16;

    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: copyDstUsage | textureBindingUsage | renderAttachmentUsage,
      }),
    );
  });
});

