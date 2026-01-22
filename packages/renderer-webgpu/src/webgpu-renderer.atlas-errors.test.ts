import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import type { AssetId, AssetManifest } from '@idle-engine/renderer-contract';
import type * as AtlasPackerModule from './atlas-packer.js';

vi.mock('./atlas-packer.js', async (importOriginal) => {
  const actual = (await importOriginal()) as AtlasPackerModule;
  return {
    ...actual,
    packAtlas: vi.fn(actual.packAtlas),
  };
});

import { createWebGpuRenderer } from './webgpu-renderer.js';
import { packAtlas } from './atlas-packer.js';

describe('renderer-webgpu atlas errors', () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function setNavigator(value: unknown): void {
    Object.defineProperty(globalThis, 'navigator', {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  function createStubWebGpuEnvironment(): { canvas: HTMLCanvasElement } {
    const deviceLost = new Promise<GPUDeviceLostInfo>(() => undefined);

    const queue = {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
    } as unknown as GPUQueue;

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
      createTexture: vi.fn(
        () =>
          ({
            createView: vi.fn(() => ({} as unknown as GPUTextureView)),
            destroy: vi.fn(),
          }) as unknown as GPUTexture,
      ),
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

    return { canvas };
  }

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    } else {
      delete (globalThis as unknown as { navigator?: unknown }).navigator;
    }
  });

  it('throws when atlas packing returns entries missing loaded sources', async () => {
    vi.mocked(packAtlas).mockImplementationOnce(() => ({
      atlasWidthPx: 8,
      atlasHeightPx: 8,
      paddingPx: 0,
      entries: [
        {
          assetId: 'sprite:unknown' as AssetId,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
    }));

    const { canvas } = createStubWebGpuEnvironment();
    const renderer = await createWebGpuRenderer(canvas);

    const manifest = {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      assets: [{ id: 'sprite:demo' as AssetId, kind: 'image', contentHash: 'hash:demo' }],
    } satisfies AssetManifest;

    const loadImage = vi.fn(
      async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource),
    );

    await expect(renderer.loadAssets(manifest, { loadImage })).rejects.toThrow(
      'Missing loaded image for AssetId: sprite:unknown',
    );
  });

  it('throws when atlas packing omits font entries required for bitmap font state', async () => {
    vi.mocked(packAtlas).mockImplementationOnce(() => ({
      atlasWidthPx: 8,
      atlasHeightPx: 8,
      paddingPx: 0,
      entries: [],
    }));

    const { canvas } = createStubWebGpuEnvironment();
    const renderer = await createWebGpuRenderer(canvas);

    const fontAssetId = 'font:demo' as AssetId;
    const manifest = {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      assets: [{ id: fontAssetId, kind: 'font', contentHash: 'hash:font' }],
    } satisfies AssetManifest;

    const loadImage = vi.fn(
      async () => ({ width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource),
    );
    const loadFont = vi.fn(async () => ({
      image: { width: 8, height: 8 } as unknown as GPUImageCopyExternalImageSource,
      baseFontSizePx: 8,
      lineHeightPx: 8,
      glyphs: [],
    }));

    await expect(renderer.loadAssets(manifest, { loadImage, loadFont })).rejects.toThrow(
      `Missing font atlas data for asset ${fontAssetId}`,
    );
  });
});
