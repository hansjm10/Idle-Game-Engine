import {
  canonicalEncodeForHash,
  sha256Hex,
} from '@idle-engine/renderer-contract';
import type {
  AssetId,
  AssetManifest,
  Camera2D,
  RenderCommandBuffer,
  Sha256Hex,
} from '@idle-engine/renderer-contract';

import {
  createAtlasLayout,
  packAtlas,
} from './atlas-packer.js';
import type { WebGpuAtlasLayout } from './atlas-packer.js';
import {
  buildSpriteInstances,
  orderDrawsByPassAndSortKey,
} from './sprite-batching.js';
import type {
  SpriteUvRect,
} from './sprite-batching.js';

export class WebGpuNotSupportedError extends Error {
  override name = 'WebGpuNotSupportedError';
}

export class WebGpuDeviceLostError extends Error {
  override name = 'WebGpuDeviceLostError';

  readonly reason: GPUDeviceLostReason | undefined;

  constructor(message: string, reason?: GPUDeviceLostReason) {
    super(message);
    this.reason = reason;
  }
}

export interface WebGpuRendererResizeOptions {
  readonly devicePixelRatio?: number;
}

export interface WebGpuRendererAssets {
  loadImage(
    assetId: AssetId,
    contentHash: Sha256Hex,
  ): Promise<GPUImageCopyExternalImageSource>;
}

export interface WebGpuRendererLoadAssetsOptions {
  readonly maxAtlasSizePx?: number;
  readonly paddingPx?: number;
  readonly powerOfTwo?: boolean;
}

export interface WebGpuRendererAtlasState {
  readonly layout: WebGpuAtlasLayout;
  readonly layoutHash: Sha256Hex;
}

export interface WebGpuRendererCreateOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly deviceDescriptor?: GPUDeviceDescriptor;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly preferredFormats?: readonly GPUTextureFormat[];
  readonly onDeviceLost?: (error: WebGpuDeviceLostError) => void;
}

export interface WebGpuRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly format: GPUTextureFormat;
  readonly atlasLayout: WebGpuAtlasLayout | undefined;
  readonly atlasLayoutHash: Sha256Hex | undefined;

  resize(options?: WebGpuRendererResizeOptions): void;
  loadAssets(
    manifest: AssetManifest,
    assets: WebGpuRendererAssets,
    options?: WebGpuRendererLoadAssetsOptions,
  ): Promise<WebGpuRendererAtlasState>;
  setWorldCamera(camera: Camera2D): void;
  render(rcb: RenderCommandBuffer): void;
  dispose(): void;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(255, Math.max(0, Math.floor(value)));
}

function colorRgbaToGpuColor(colorRgba: number): GPUColor {
  const rgba = colorRgba >>> 0;
  const red = clampByte((rgba >>> 24) & 0xff);
  const green = clampByte((rgba >>> 16) & 0xff);
  const blue = clampByte((rgba >>> 8) & 0xff);
  const alpha = clampByte(rgba & 0xff);

  return {
    r: red / 255,
    g: green / 255,
    b: blue / 255,
    a: alpha / 255,
  };
}

function selectClearColor(rcb: RenderCommandBuffer): GPUColor {
  const primaryPassId = rcb.passes[0]?.id;
  const clearDrawByPass =
    primaryPassId === undefined
      ? undefined
      : rcb.draws.find(
          (draw) => draw.kind === 'clear' && draw.passId === primaryPassId,
        );
  const clearDrawCandidate =
    clearDrawByPass ?? rcb.draws.find((draw) => draw.kind === 'clear');
  if (!clearDrawCandidate || clearDrawCandidate.kind !== 'clear') {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  return colorRgbaToGpuColor(clearDrawCandidate.colorRgba);
}

function getCanvasPixelSize(
  canvas: HTMLCanvasElement,
  devicePixelRatio: number,
): { width: number; height: number } {
  const targetWidth = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const targetHeight = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
  return { width: targetWidth, height: targetHeight };
}

function configureCanvasContext(options: {
  context: GPUCanvasContext;
  device: GPUDevice;
  format: GPUTextureFormat;
  alphaMode: GPUCanvasAlphaMode;
}): void {
  try {
    options.context.configure({
      device: options.device,
      format: options.format,
      alphaMode: options.alphaMode,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WebGpuNotSupportedError(
      `Failed to configure WebGPU canvas context (format: ${options.format})${
        message ? `: ${message}` : ''
      }`,
    );
  }
}

const GLOBALS_UNIFORM_BYTES = 32;
const GLOBALS_UNIFORM_ALIGNMENT = 256;
const WORLD_GLOBALS_OFFSET = 0;
const UI_GLOBALS_OFFSET = GLOBALS_UNIFORM_ALIGNMENT;
const GLOBALS_BUFFER_SIZE = GLOBALS_UNIFORM_ALIGNMENT * 2;

const QUAD_VERTEX_STRIDE_BYTES = 16;
const INSTANCE_STRIDE_BYTES = 48;

const QUAD_VERTEX_DATA = new Float32Array([
  0, 0, 0, 0,
  1, 0, 1, 0,
  0, 1, 0, 1,
  1, 1, 1, 1,
]);

const QUAD_INDEX_DATA = new Uint16Array([0, 1, 2, 2, 1, 3]);

const SPRITE_SHADER = `
struct Globals {
  viewportSize: vec2<f32>,
  devicePixelRatio: f32,
  _pad0: f32,
  camera: vec3<f32>,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var spriteSampler: sampler;
@group(1) @binding(1) var spriteTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) localPos: vec2<f32>,
  @location(1) localUv: vec2<f32>,
  @location(2) instancePosSize: vec4<f32>,
  @location(3) instanceUvRect: vec4<f32>,
  @location(4) instanceColor: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let localPx = input.instancePosSize.xy + input.localPos * input.instancePosSize.zw;
  let cameraPx = (localPx - globals.camera.xy) * globals.camera.z;
  let posPx = cameraPx * globals.devicePixelRatio;

  let ndcX = (posPx.x / globals.viewportSize.x) * 2.0 - 1.0;
  let ndcY = 1.0 - (posPx.y / globals.viewportSize.y) * 2.0;

  let uv = mix(input.instanceUvRect.xy, input.instanceUvRect.zw, input.localUv);

  var out: VertexOutput;
  out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.uv = uv;
  out.color = input.instanceColor;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texel = textureSample(spriteTexture, spriteSampler, input.uv);
  return texel * input.color;
}
`;

function getExternalImageSize(source: GPUImageCopyExternalImageSource): { width: number; height: number } {
  const record = source as unknown as Record<string, unknown>;

  const width =
    pickFiniteNumber(record, ['width', 'naturalWidth', 'videoWidth', 'codedWidth']) ?? 0;
  const height =
    pickFiniteNumber(record, ['height', 'naturalHeight', 'videoHeight', 'codedHeight']) ?? 0;

  return { width: Math.floor(width), height: Math.floor(height) };
}

function pickFiniteNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = view;

  if (buffer instanceof ArrayBuffer) {
    if (byteOffset === 0 && byteLength === buffer.byteLength) {
      return buffer;
    }
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  const copy = new Uint8Array(byteLength);
  copy.set(new Uint8Array(buffer, byteOffset, byteLength));
  return copy.buffer;
}

function isRenderableImageAssetKind(kind: string): boolean {
  return kind === 'image' || kind === 'spriteSheet';
}

function compareAssetId(a: AssetId, b: AssetId): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

const GPU_SHADER_STAGE: { readonly VERTEX: number; readonly FRAGMENT: number; readonly COMPUTE: number } =
  (globalThis as unknown as { GPUShaderStage?: { VERTEX: number; FRAGMENT: number; COMPUTE: number } })
    .GPUShaderStage ?? { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

const GPU_BUFFER_USAGE: {
  readonly COPY_DST: number;
  readonly INDEX: number;
  readonly UNIFORM: number;
  readonly VERTEX: number;
} =
  (globalThis as unknown as { GPUBufferUsage?: { COPY_DST: number; INDEX: number; UNIFORM: number; VERTEX: number } })
    .GPUBufferUsage ?? {
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
  };

const GPU_TEXTURE_USAGE: { readonly COPY_DST: number; readonly TEXTURE_BINDING: number } =
  (globalThis as unknown as { GPUTextureUsage?: { COPY_DST: number; TEXTURE_BINDING: number } })
    .GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4 };

class WebGpuRendererImpl implements WebGpuRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;

  readonly #alphaMode: GPUCanvasAlphaMode;
  readonly #onDeviceLost: ((error: WebGpuDeviceLostError) => void) | undefined;
  #disposed = false;
  #lost = false;
  #devicePixelRatio = 1;
  #worldCamera: Camera2D = { x: 0, y: 0, zoom: 1 };

  #spritePipeline: GPURenderPipeline | undefined;
  #spriteSampler: GPUSampler | undefined;
  #spriteUniformBuffer: GPUBuffer | undefined;
  #worldGlobalsBindGroup: GPUBindGroup | undefined;
  #uiGlobalsBindGroup: GPUBindGroup | undefined;
  #spriteVertexBuffer: GPUBuffer | undefined;
  #spriteIndexBuffer: GPUBuffer | undefined;
  #spriteInstanceBuffer: GPUBuffer | undefined;
  #spriteInstanceBufferSize = 0;
  #spriteTextureBindGroupLayout: GPUBindGroupLayout | undefined;
  #spriteTextureBindGroup: GPUBindGroup | undefined;

  #atlasLayout: WebGpuAtlasLayout | undefined;
  #atlasLayoutHash: Sha256Hex | undefined;
  #atlasUvByAssetId: Map<AssetId, SpriteUvRect> | undefined;

  constructor(options: {
    canvas: HTMLCanvasElement;
    context: GPUCanvasContext;
    adapter: GPUAdapter;
    device: GPUDevice;
    format: GPUTextureFormat;
    alphaMode: GPUCanvasAlphaMode;
    onDeviceLost?: (error: WebGpuDeviceLostError) => void;
  }) {
    this.canvas = options.canvas;
    this.context = options.context;
    this.adapter = options.adapter;
    this.device = options.device;
    this.format = options.format;
    this.#alphaMode = options.alphaMode;
    this.#onDeviceLost = options.onDeviceLost;

    void this.device.lost
      .then((info) => {
        if (this.#disposed) {
          return;
        }
        this.#lost = true;
        try {
          this.#onDeviceLost?.(
            new WebGpuDeviceLostError(
              `WebGPU device lost${info.message ? `: ${info.message}` : ''}`,
              info.reason,
            ),
          );
        } catch (error: unknown) {
          void error;
        }
      })
      .catch(() => undefined);
  }

  get atlasLayout(): WebGpuAtlasLayout | undefined {
    return this.#atlasLayout;
  }

  get atlasLayoutHash(): Sha256Hex | undefined {
    return this.#atlasLayoutHash;
  }

  resize(options?: WebGpuRendererResizeOptions): void {
    if (this.#disposed || this.#lost) {
      return;
    }

    const devicePixelRatio =
      options?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    this.#devicePixelRatio = devicePixelRatio;
    const { width, height } = getCanvasPixelSize(this.canvas, devicePixelRatio);

    if (this.canvas.width === width && this.canvas.height === height) {
      return;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    configureCanvasContext({
      context: this.context,
      device: this.device,
      format: this.format,
      alphaMode: this.#alphaMode,
    });
  }

  async loadAssets(
    manifest: AssetManifest,
    assets: WebGpuRendererAssets,
    options?: WebGpuRendererLoadAssetsOptions,
  ): Promise<WebGpuRendererAtlasState> {
    if (this.#disposed) {
      throw new Error('WebGPU renderer is disposed.');
    }
    if (this.#lost) {
      throw new Error('WebGPU device is lost.');
    }

    this.#ensureSpritePipeline();

    const imageEntries = manifest.assets
      .filter((entry) => isRenderableImageAssetKind(entry.kind))
      .slice()
      .sort((a, b) => compareAssetId(a.id, b.id));

    for (let index = 1; index < imageEntries.length; index += 1) {
      const previous = imageEntries[index - 1];
      const current = imageEntries[index];
      if (previous && current && previous.id === current.id) {
        throw new Error(`AssetManifest contains duplicate AssetId: ${current.id}`);
      }
    }

    const loadedSources = await Promise.all(
      imageEntries.map(async (entry) => ({
        entry,
        source: await assets.loadImage(entry.id, entry.contentHash),
      })),
    );

    const atlasImages = loadedSources.map(({ entry, source }) => {
      const size = getExternalImageSize(source);
      if (size.width <= 0 || size.height <= 0) {
        throw new Error(
          `Loaded image ${entry.id} has invalid dimensions ${size.width}x${size.height}.`,
        );
      }

      return {
        assetId: entry.id,
        width: size.width,
        height: size.height,
      };
    });

    const packed = packAtlas(atlasImages, {
      maxSizePx: options?.maxAtlasSizePx,
      paddingPx: options?.paddingPx,
      powerOfTwo: options?.powerOfTwo,
    });
    const layout = createAtlasLayout(packed);
    const layoutHash = await sha256Hex(canonicalEncodeForHash(layout));

    const atlasTexture = this.device.createTexture({
      size: [packed.atlasWidthPx, packed.atlasHeightPx, 1],
      format: 'rgba8unorm',
      usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST,
    });

    const sourceByAssetId = new Map<AssetId, GPUImageCopyExternalImageSource>();
    for (const { entry, source } of loadedSources) {
      sourceByAssetId.set(entry.id, source);
    }

    for (const entry of packed.entries) {
      const source = sourceByAssetId.get(entry.assetId);
      if (!source) {
        throw new Error(`Missing loaded image for AssetId: ${entry.assetId}`);
      }

      this.device.queue.copyExternalImageToTexture(
        { source },
        {
          texture: atlasTexture,
          origin: { x: entry.x, y: entry.y },
        },
        { width: entry.width, height: entry.height },
      );
    }

    const atlasView = atlasTexture.createView();
    const textureBindGroupLayout = this.#spriteTextureBindGroupLayout;
    const sampler = this.#spriteSampler;
    if (!textureBindGroupLayout || !sampler) {
      throw new Error('Sprite pipeline missing texture bindings.');
    }

    this.#spriteTextureBindGroup = this.device.createBindGroup({
      layout: textureBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: atlasView },
      ],
    });

    const uvByAssetId = new Map<AssetId, SpriteUvRect>();
    for (const entry of packed.entries) {
      uvByAssetId.set(entry.assetId, {
        u0: entry.x / packed.atlasWidthPx,
        v0: entry.y / packed.atlasHeightPx,
        u1: (entry.x + entry.width) / packed.atlasWidthPx,
        v1: (entry.y + entry.height) / packed.atlasHeightPx,
      });
    }

    this.#atlasLayout = layout;
    this.#atlasLayoutHash = layoutHash;
    this.#atlasUvByAssetId = uvByAssetId;

    return { layout, layoutHash };
  }

  setWorldCamera(camera: Camera2D): void {
    this.#worldCamera = camera;
  }

  #ensureSpritePipeline(): void {
    if (this.#spritePipeline) {
      return;
    }

    const uniformBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.#spriteTextureBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE.FRAGMENT,
          texture: { sampleType: 'float' },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [uniformBindGroupLayout, this.#spriteTextureBindGroupLayout],
    });

    const shaderModule = this.device.createShaderModule({ code: SPRITE_SHADER });

    this.#spritePipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: QUAD_VERTEX_STRIDE_BYTES,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x2' },
            ],
          },
          {
            arrayStride: INSTANCE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'float32x4' },
              { shaderLocation: 3, offset: 16, format: 'float32x4' },
              { shaderLocation: 4, offset: 32, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });

    this.#spriteSampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.#spriteUniformBuffer = this.device.createBuffer({
      size: GLOBALS_BUFFER_SIZE,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    });

    this.#worldGlobalsBindGroup = this.device.createBindGroup({
      layout: uniformBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.#spriteUniformBuffer,
            offset: WORLD_GLOBALS_OFFSET,
            size: GLOBALS_UNIFORM_BYTES,
          },
        },
      ],
    });

    this.#uiGlobalsBindGroup = this.device.createBindGroup({
      layout: uniformBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.#spriteUniformBuffer,
            offset: UI_GLOBALS_OFFSET,
            size: GLOBALS_UNIFORM_BYTES,
          },
        },
      ],
    });

    this.#spriteVertexBuffer = this.device.createBuffer({
      size: QUAD_VERTEX_DATA.byteLength,
      usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
    });

    this.#spriteIndexBuffer = this.device.createBuffer({
      size: QUAD_INDEX_DATA.byteLength,
      usage: GPU_BUFFER_USAGE.INDEX | GPU_BUFFER_USAGE.COPY_DST,
    });

    this.device.queue.writeBuffer(this.#spriteVertexBuffer, 0, toArrayBuffer(QUAD_VERTEX_DATA));
    this.device.queue.writeBuffer(this.#spriteIndexBuffer, 0, toArrayBuffer(QUAD_INDEX_DATA));
  }

  #ensureInstanceBuffer(requiredBytes: number): void {
    if (this.#spriteInstanceBuffer && this.#spriteInstanceBufferSize >= requiredBytes) {
      return;
    }

    const size = Math.max(1024, this.#spriteInstanceBufferSize * 2, requiredBytes);
    this.#spriteInstanceBuffer = this.device.createBuffer({
      size,
      usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
    });
    this.#spriteInstanceBufferSize = size;
  }

  #writeGlobals(offset: number, camera: Camera2D): void {
    const buffer = this.#spriteUniformBuffer;
    if (!buffer) {
      throw new Error('Sprite pipeline missing globals buffer.');
    }

    const data = new Float32Array([
      this.canvas.width,
      this.canvas.height,
      this.#devicePixelRatio,
      0,
      camera.x,
      camera.y,
      camera.zoom,
      0,
    ]);

    this.device.queue.writeBuffer(buffer, offset, toArrayBuffer(data));
  }

  render(rcb: RenderCommandBuffer): void {
    if (this.#disposed || this.#lost) {
      return;
    }

    const colorTextureView = this.context.getCurrentTexture().createView();
    const clearColor = selectClearColor(rcb);

    const commandEncoder = this.device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorTextureView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: clearColor,
        },
      ],
    });

    const orderedDraws = orderDrawsByPassAndSortKey(rcb);
    const atlasUvByAssetId = this.#atlasUvByAssetId;
    const textureBindGroup = this.#spriteTextureBindGroup;

    if (orderedDraws.some((entry) => entry.draw.kind === 'image')) {
      if (!atlasUvByAssetId || !textureBindGroup) {
        throw new Error('No sprite atlas loaded. Call renderer.loadAssets(...) before rendering sprites.');
      }

      this.#ensureSpritePipeline();

      const spriteInstances = buildSpriteInstances({
        orderedDraws,
        uvByAssetId: atlasUvByAssetId,
      });

      if (spriteInstances.instanceCount > 0) {
        const instanceBytes = spriteInstances.instances.byteLength;
        this.#ensureInstanceBuffer(instanceBytes);

        const pipeline = this.#spritePipeline;
        const vertexBuffer = this.#spriteVertexBuffer;
        const indexBuffer = this.#spriteIndexBuffer;
        const instanceBuffer = this.#spriteInstanceBuffer;
        const worldGlobalsBindGroup = this.#worldGlobalsBindGroup;
        const uiGlobalsBindGroup = this.#uiGlobalsBindGroup;

        if (
          !pipeline ||
          !vertexBuffer ||
          !indexBuffer ||
          !instanceBuffer ||
          !worldGlobalsBindGroup ||
          !uiGlobalsBindGroup
        ) {
          throw new Error('Sprite pipeline is incomplete.');
        }

        this.#writeGlobals(WORLD_GLOBALS_OFFSET, this.#worldCamera);
        this.#writeGlobals(UI_GLOBALS_OFFSET, { x: 0, y: 0, zoom: 1 });

        this.device.queue.writeBuffer(instanceBuffer, 0, toArrayBuffer(spriteInstances.instances));

        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(1, textureBindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setVertexBuffer(1, instanceBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');

        for (const group of spriteInstances.groups) {
          const globals = group.passId === 'world' ? worldGlobalsBindGroup : uiGlobalsBindGroup;
          passEncoder.setBindGroup(0, globals);
          passEncoder.drawIndexed(6, group.instanceCount, 0, 0, group.firstInstance);
        }
      }
    }

    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  dispose(): void {
    this.#disposed = true;
  }
}

function getNavigatorGpu(): GPU {
  const maybeNavigator = globalThis.navigator as Navigator | undefined;
  if (!maybeNavigator?.gpu) {
    throw new WebGpuNotSupportedError('WebGPU is not available in this environment.');
  }
  return maybeNavigator.gpu;
}

function getDefaultCanvasFormat(
  gpu: GPU,
  context: GPUCanvasContext,
  adapter: GPUAdapter,
): GPUTextureFormat {
  if ('getPreferredCanvasFormat' in gpu && typeof gpu.getPreferredCanvasFormat === 'function') {
    return gpu.getPreferredCanvasFormat();
  }

  const legacyContext = context as unknown as {
    getPreferredFormat?: (adapter: GPUAdapter) => GPUTextureFormat;
  };
  if (typeof legacyContext.getPreferredFormat === 'function') {
    return legacyContext.getPreferredFormat(adapter);
  }

  return 'bgra8unorm';
}

function pickPreferredFormat(options: {
  gpu: GPU;
  context: GPUCanvasContext;
  adapter: GPUAdapter;
  preferredFormats?: readonly GPUTextureFormat[];
}): GPUTextureFormat {
  if (options.preferredFormats?.length) {
    return options.preferredFormats[0];
  }

  return getDefaultCanvasFormat(options.gpu, options.context, options.adapter);
}

export async function createWebGpuRenderer(
  canvas: HTMLCanvasElement,
  options?: WebGpuRendererCreateOptions,
): Promise<WebGpuRenderer> {
  const gpu = getNavigatorGpu();

  const adapter = await gpu.requestAdapter({
    powerPreference: options?.powerPreference,
  });
  if (!adapter) {
    throw new WebGpuNotSupportedError('WebGPU adapter not found.');
  }

  const requiredFeatures = options?.requiredFeatures ?? [];
  for (const feature of requiredFeatures) {
    if (!adapter.features.has(feature)) {
      throw new WebGpuNotSupportedError(`Required WebGPU feature not supported: ${feature}`);
    }
  }

  const device = await adapter.requestDevice({
    ...options?.deviceDescriptor,
    requiredFeatures: requiredFeatures.length
      ? Array.from(requiredFeatures)
      : options?.deviceDescriptor?.requiredFeatures,
  });

  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new WebGpuNotSupportedError('Failed to acquire WebGPU canvas context.');
  }

  const format = pickPreferredFormat({
    gpu,
    context,
    adapter,
    preferredFormats: options?.preferredFormats,
  });
  const alphaMode = options?.alphaMode ?? 'opaque';
  configureCanvasContext({ context, device, format, alphaMode });

  const renderer = new WebGpuRendererImpl({
    canvas,
    context,
    adapter,
    device,
    format,
    alphaMode,
    onDeviceLost: options?.onDeviceLost,
  });
  renderer.resize();

  return renderer;
}

export const __test__ = {
  colorRgbaToGpuColor,
  getCanvasPixelSize,
  selectClearColor,
  getExternalImageSize,
};
