import {
  canonicalEncodeForHash,
  sha256Hex,
} from '@idle-engine/renderer-contract';
import type {
  AssetId,
  AssetManifest,
  Camera2D,
  RenderCommandBuffer,
  RenderPassId,
  Sha256Hex,
} from '@idle-engine/renderer-contract';

import {
  createAtlasLayout,
  packAtlas,
} from './atlas-packer.js';
import type { WebGpuAtlasLayout } from './atlas-packer.js';
import {
  orderDrawsByPassAndSortKey,
} from './sprite-batching.js';
import type {
  OrderedDraw,
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
  if (clearDrawCandidate?.kind !== 'clear') {
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

interface ScissorRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function isSameScissorRect(a: ScissorRect, b: ScissorRect): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function intersectScissorRect(a: ScissorRect, b: ScissorRect): ScissorRect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);

  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);

  return {
    x: x0,
    y: y0,
    width,
    height,
  };
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

const RECT_SHADER = `
struct Globals {
  viewportSize: vec2<f32>,
  devicePixelRatio: f32,
  _pad0: f32,
  camera: vec3<f32>,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> globals: Globals;

struct VertexInput {
  @location(0) localPos: vec2<f32>,
  @location(1) localUv: vec2<f32>,
  @location(2) instancePosSize: vec4<f32>,
  @location(4) instanceColor: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let localPx = input.instancePosSize.xy + input.localPos * input.instancePosSize.zw;
  let cameraPx = (localPx - globals.camera.xy) * globals.camera.z;
  let posPx = cameraPx * globals.devicePixelRatio;

  let ndcX = (posPx.x / globals.viewportSize.x) * 2.0 - 1.0;
  let ndcY = 1.0 - (posPx.y / globals.viewportSize.y) * 2.0;

  var out: VertexOutput;
  out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.color = input.instanceColor;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
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
  #rectPipeline: GPURenderPipeline | undefined;
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

    this.device.lost
      .then((info) => {
        if (this.#disposed) {
          return;
        }
        this.#lost = true;
        const message = info.message ? `WebGPU device lost: ${info.message}` : 'WebGPU device lost';
        this.#onDeviceLost?.(new WebGpuDeviceLostError(message, info.reason));
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
    if (this.#spritePipeline && this.#rectPipeline) {
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

    const rectPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [uniformBindGroupLayout],
    });

    const rectShaderModule = this.device.createShaderModule({ code: RECT_SHADER });

    this.#rectPipeline = this.device.createRenderPipeline({
      layout: rectPipelineLayout,
      vertex: {
        module: rectShaderModule,
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
              { shaderLocation: 4, offset: 32, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module: rectShaderModule,
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

  #toDeviceScissorRect(options: {
    readonly passId: RenderPassId;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): ScissorRect {
    const viewportWidth = this.canvas.width;
    const viewportHeight = this.canvas.height;

    const width = Number.isFinite(options.width) ? Math.max(0, options.width) : 0;
    const height = Number.isFinite(options.height) ? Math.max(0, options.height) : 0;
    const x0Input = Number.isFinite(options.x) ? options.x : 0;
    const y0Input = Number.isFinite(options.y) ? options.y : 0;
    const x1Input = x0Input + width;
    const y1Input = y0Input + height;

    const devicePixelRatio = this.#devicePixelRatio;

    let deviceX0 = 0;
    let deviceY0 = 0;
    let deviceX1 = 0;
    let deviceY1 = 0;

    if (options.passId === 'ui') {
      deviceX0 = x0Input * devicePixelRatio;
      deviceY0 = y0Input * devicePixelRatio;
      deviceX1 = x1Input * devicePixelRatio;
      deviceY1 = y1Input * devicePixelRatio;
    } else {
      const camera = this.#worldCamera;
      deviceX0 = (x0Input - camera.x) * camera.zoom * devicePixelRatio;
      deviceY0 = (y0Input - camera.y) * camera.zoom * devicePixelRatio;
      deviceX1 = (x1Input - camera.x) * camera.zoom * devicePixelRatio;
      deviceY1 = (y1Input - camera.y) * camera.zoom * devicePixelRatio;
    }

    const minX = Math.floor(Math.min(deviceX0, deviceX1));
    const minY = Math.floor(Math.min(deviceY0, deviceY1));
    const maxX = Math.ceil(Math.max(deviceX0, deviceX1));
    const maxY = Math.ceil(Math.max(deviceY0, deviceY1));

    const clampedX0 = Math.max(0, Math.min(viewportWidth, minX));
    const clampedY0 = Math.max(0, Math.min(viewportHeight, minY));
    const clampedX1 = Math.max(clampedX0, Math.min(viewportWidth, maxX));
    const clampedY1 = Math.max(clampedY0, Math.min(viewportHeight, maxY));

    return {
      x: clampedX0,
      y: clampedY0,
      width: clampedX1 - clampedX0,
      height: clampedY1 - clampedY0,
    };
  }

	  #renderDraws(passEncoder: GPURenderPassEncoder, orderedDraws: readonly OrderedDraw[]): void {
	    const hasQuadDraws = orderedDraws.some(
	      (entry) => entry.draw.kind === 'rect' || entry.draw.kind === 'image',
	    );
	    if (!hasQuadDraws) {
	      return;
	    }
	
	    const atlasUvByAssetId = this.#atlasUvByAssetId;
	    const textureBindGroup = this.#spriteTextureBindGroup;
	    if (
	      orderedDraws.some((entry) => entry.draw.kind === 'image') &&
	      (!atlasUvByAssetId || !textureBindGroup)
	    ) {
	      throw new Error(
	        'No sprite atlas loaded. Call renderer.loadAssets(...) before rendering image draws.',
	      );
	    }

    this.#ensureSpritePipeline();

    const spritePipeline = this.#spritePipeline;
    const rectPipeline = this.#rectPipeline;
    const vertexBuffer = this.#spriteVertexBuffer;
    const indexBuffer = this.#spriteIndexBuffer;
    const worldGlobalsBindGroup = this.#worldGlobalsBindGroup;
    const uiGlobalsBindGroup = this.#uiGlobalsBindGroup;

    if (
      !spritePipeline ||
      !rectPipeline ||
      !vertexBuffer ||
      !indexBuffer ||
      !worldGlobalsBindGroup ||
      !uiGlobalsBindGroup
    ) {
      throw new Error('Quad pipelines are incomplete.');
    }

    this.#writeGlobals(WORLD_GLOBALS_OFFSET, this.#worldCamera);
    this.#writeGlobals(UI_GLOBALS_OFFSET, { x: 0, y: 0, zoom: 1 });

    const viewportScissor: ScissorRect = {
      x: 0,
      y: 0,
      width: this.canvas.width,
      height: this.canvas.height,
    };

    let appliedScissor: ScissorRect | undefined;
    const applyScissorRect = (rect: ScissorRect): void => {
      if (appliedScissor && isSameScissorRect(appliedScissor, rect)) {
        return;
      }

      passEncoder.setScissorRect(rect.x, rect.y, rect.width, rect.height);
      appliedScissor = rect;
    };

    applyScissorRect(viewportScissor);

    let currentPassId: RenderPassId | undefined;
    let scissorStack: ScissorRect[] = [];
    let currentScissor = viewportScissor;

    type BatchKind = 'rect' | 'image';
	    let batchKind: BatchKind | undefined;
	    let batchPassId: RenderPassId | undefined;
	    let batchInstances: number[] = [];
	    let batchInstanceCount = 0;

	    const flushBatch = (): void => {
	      if (!batchKind || !batchPassId || batchInstanceCount <= 0) {
	        batchKind = undefined;
	        batchPassId = undefined;
        batchInstances = [];
        batchInstanceCount = 0;
        return;
      }

      if (currentScissor.width <= 0 || currentScissor.height <= 0) {
        batchKind = undefined;
        batchPassId = undefined;
        batchInstances = [];
        batchInstanceCount = 0;
        return;
      }

      const instances = new Float32Array(batchInstances);
      this.#ensureInstanceBuffer(instances.byteLength);

      const ensuredInstanceBuffer = this.#spriteInstanceBuffer;
      if (!ensuredInstanceBuffer) {
        throw new Error('Sprite pipeline missing instance buffer.');
      }

      this.device.queue.writeBuffer(ensuredInstanceBuffer, 0, toArrayBuffer(instances));

      const globals = batchPassId === 'world' ? worldGlobalsBindGroup : uiGlobalsBindGroup;

      if (batchKind === 'image') {
        if (!textureBindGroup) {
          throw new Error('Sprite pipeline missing texture bind group.');
        }
        passEncoder.setPipeline(spritePipeline);
        passEncoder.setBindGroup(1, textureBindGroup);
      } else {
        passEncoder.setPipeline(rectPipeline);
      }

      passEncoder.setBindGroup(0, globals);
      passEncoder.setVertexBuffer(0, vertexBuffer);
      passEncoder.setVertexBuffer(1, ensuredInstanceBuffer);
      passEncoder.setIndexBuffer(indexBuffer, 'uint16');
      passEncoder.drawIndexed(6, batchInstanceCount, 0, 0, 0);

      batchKind = undefined;
      batchPassId = undefined;
	      batchInstances = [];
	      batchInstanceCount = 0;
	    };

	    const ensureBatch = (kind: BatchKind, passId: RenderPassId): void => {
	      if (batchKind === kind && batchPassId === passId) {
	        return;
	      }
	      flushBatch();
	      batchKind = kind;
	      batchPassId = passId;
	    };

	    const spriteUvOrThrow = (assetId: AssetId): SpriteUvRect => {
	      if (!atlasUvByAssetId) {
	        throw new Error('Sprite atlas missing UVs.');
	      }

	      const uv = atlasUvByAssetId.get(assetId);
	      if (!uv) {
	        throw new Error(`Atlas missing UVs for AssetId: ${assetId}`);
	      }

	      return uv;
	    };

	    for (const entry of orderedDraws) {
	      const draw = entry.draw;

      if (currentPassId !== entry.passId) {
        flushBatch();
        currentPassId = entry.passId;
        scissorStack = [];
        currentScissor = viewportScissor;
        applyScissorRect(currentScissor);
      }

	      switch (draw.kind) {
	        case 'scissorPush': {
	          flushBatch();
	          const scissor = this.#toDeviceScissorRect({
            passId: entry.passId,
            x: draw.x,
            y: draw.y,
            width: draw.width,
            height: draw.height,
          });
          scissorStack.push(currentScissor);
          currentScissor = intersectScissorRect(currentScissor, scissor);
          applyScissorRect(currentScissor);
          break;
        }
        case 'scissorPop': {
          flushBatch();
          currentScissor = scissorStack.pop() ?? viewportScissor;
	          applyScissorRect(currentScissor);
	          break;
	        }
	        case 'rect': {
	          ensureBatch('rect', entry.passId);

	          const rgba = draw.colorRgba >>> 0;
	          const red = clampByte((rgba >>> 24) & 0xff) / 255;
	          const green = clampByte((rgba >>> 16) & 0xff) / 255;
          const blue = clampByte((rgba >>> 8) & 0xff) / 255;
          const alpha = clampByte(rgba & 0xff) / 255;

          batchInstances.push(
            draw.x,
            draw.y,
            draw.width,
            draw.height,
            0,
            0,
            0,
            0,
            red,
            green,
            blue,
            alpha,
          );
	          batchInstanceCount += 1;
	          break;
	        }
	        case 'image': {
	          ensureBatch('image', entry.passId);

	          const uv = spriteUvOrThrow(draw.assetId);

	          const tintAlpha = (((draw.tintRgba ?? 0xff) >>> 0) & 0xff) / 255;

	          batchInstances.push(
	            draw.x,
	            draw.y,
            draw.width,
            draw.height,
            uv.u0,
            uv.v0,
            uv.u1,
            uv.v1,
            1,
            1,
            1,
            tintAlpha,
          );
          batchInstanceCount += 1;
          break;
        }
        default:
          flushBatch();
          break;
      }
    }

    flushBatch();
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
    this.#renderDraws(passEncoder, orderedDraws);

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
