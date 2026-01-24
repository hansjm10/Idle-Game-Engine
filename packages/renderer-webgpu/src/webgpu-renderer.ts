import {
  RENDERER_CONTRACT_SCHEMA_VERSION,
  WORLD_FIXED_POINT_SCALE,
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

export interface WebGpuRendererLimits {
  /**
   * Maximum number of entries allowed in `AssetManifest.assets`.
   *
   * Default: 10_000
   */
  readonly maxAssets?: number;
  /**
   * Maximum number of draws allowed in a single `RenderCommandBuffer`.
   *
   * Default: 100_000
   */
  readonly maxDrawsPerFrame?: number;
  /**
   * Maximum text length (measured in JavaScript UTF-16 code units, i.e. `text.length`)
   * allowed per `TextDraw`.
   *
   * Default: 10_000
   */
  readonly maxTextLength?: number;
}

interface WebGpuRendererResolvedLimits {
  readonly maxAssets: number;
  readonly maxDrawsPerFrame: number;
  readonly maxTextLength: number;
}

const DEFAULT_WEBGPU_RENDERER_LIMITS: WebGpuRendererResolvedLimits = {
  maxAssets: 10_000,
  maxDrawsPerFrame: 100_000,
  maxTextLength: 10_000,
};

export interface WebGpuRendererResizeOptions {
  readonly devicePixelRatio?: number;
}

export interface WebGpuBitmapFontGlyph {
  readonly codePoint: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly xOffsetPx: number;
  readonly yOffsetPx: number;
  readonly xAdvancePx: number;
}

export interface WebGpuBitmapFont {
  readonly image: GPUImageCopyExternalImageSource;
  readonly baseFontSizePx: number;
  readonly lineHeightPx: number;
  readonly glyphs: readonly WebGpuBitmapFontGlyph[];
  readonly fallbackCodePoint?: number;
}

export interface WebGpuRendererAssets {
  loadImage(
    assetId: AssetId,
    contentHash: Sha256Hex,
  ): Promise<GPUImageCopyExternalImageSource>;

  loadFont?(
    assetId: AssetId,
    contentHash: Sha256Hex,
  ): Promise<WebGpuBitmapFont>;
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
  /**
   * Caps applied to untrusted inputs passed to `loadAssets(...)` and `render(...)`.
   *
   * Defaults are documented in `WebGpuRendererLimits`.
   */
  readonly limits?: WebGpuRendererLimits;
  /**
   * World-pass draw coordinates in `RenderCommandBuffer` are expected to be fixed-point integers
   * produced by `compileViewModelToRenderCommandBuffer` (`value * worldFixedPointScale`).
   *
   * Set to `1` if you are supplying world coordinates as unscaled floats.
   */
  readonly worldFixedPointScale?: number;
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
  /**
   * @deprecated Provide the camera per-frame via `rcb.scene.camera`.
   */
  setWorldCamera(camera: Camera2D): void;
  render(rcb: RenderCommandBuffer): void;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function parsePositiveIntegerLimit(
  value: number | undefined,
  fallback: number,
  path: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`WebGPU renderer expected ${path} to be a positive integer.`);
  }

  return value;
}

function resolveWebGpuRendererLimits(limits: WebGpuRendererLimits | undefined): WebGpuRendererResolvedLimits {
  return {
    maxAssets: parsePositiveIntegerLimit(
      limits?.maxAssets,
      DEFAULT_WEBGPU_RENDERER_LIMITS.maxAssets,
      'limits.maxAssets',
    ),
    maxDrawsPerFrame: parsePositiveIntegerLimit(
      limits?.maxDrawsPerFrame,
      DEFAULT_WEBGPU_RENDERER_LIMITS.maxDrawsPerFrame,
      'limits.maxDrawsPerFrame',
    ),
    maxTextLength: parsePositiveIntegerLimit(
      limits?.maxTextLength,
      DEFAULT_WEBGPU_RENDERER_LIMITS.maxTextLength,
      'limits.maxTextLength',
    ),
  };
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
const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / Float32Array.BYTES_PER_ELEMENT;

type QuadInstanceColor = { readonly red: number; readonly green: number; readonly blue: number; readonly alpha: number };
type MutableQuadInstanceColor = { red: number; green: number; blue: number; alpha: number };

const ZERO_SPRITE_UV_RECT: SpriteUvRect = { u0: 0, v0: 0, u1: 0, v1: 0 };

class QuadInstanceWriter {
  buffer: Float32Array<ArrayBuffer>;
  lengthFloats = 0;
  readonly #scratchColor: MutableQuadInstanceColor = { red: 1, green: 1, blue: 1, alpha: 1 };

  constructor(initialCapacityFloats = 0) {
    this.buffer = new Float32Array(initialCapacityFloats);
  }

  reset(): void {
    this.lengthFloats = 0;
  }

  reserveInstances(additionalInstances: number): void {
    if (additionalInstances <= 0) {
      return;
    }

    this.ensureCapacity(this.lengthFloats + additionalInstances * INSTANCE_STRIDE_FLOATS);
  }

  ensureCapacity(requiredFloats: number): void {
    if (this.buffer.length >= requiredFloats) {
      return;
    }

    const nextCapacity = Math.max(256, this.buffer.length * 2, requiredFloats);
    const next = new Float32Array(nextCapacity);
    if (this.lengthFloats > 0) {
      next.set(this.buffer.subarray(0, this.lengthFloats));
    }
    this.buffer = next;
  }

  writeInstance(x: number, y: number, width: number, height: number, uv: SpriteUvRect, color: QuadInstanceColor): void {
    const nextLengthFloats = this.lengthFloats + INSTANCE_STRIDE_FLOATS;
    this.ensureCapacity(nextLengthFloats);

    const offset = this.lengthFloats;
    const buffer = this.buffer;

    buffer[offset] = x;
    buffer[offset + 1] = y;
    buffer[offset + 2] = width;
    buffer[offset + 3] = height;
    buffer[offset + 4] = uv.u0;
    buffer[offset + 5] = uv.v0;
    buffer[offset + 6] = uv.u1;
    buffer[offset + 7] = uv.v1;
    buffer[offset + 8] = color.red;
    buffer[offset + 9] = color.green;
    buffer[offset + 10] = color.blue;
    buffer[offset + 11] = color.alpha;

    this.lengthFloats = nextLengthFloats;
  }

  writeInstanceRgba(x: number, y: number, width: number, height: number, uv: SpriteUvRect, rgba: number | undefined): void {
    const color = this.#scratchColor;
    if (rgba === undefined) {
      color.red = 1;
      color.green = 1;
      color.blue = 1;
      color.alpha = 1;
    } else {
      const packed = rgba >>> 0;
      color.red = clampByte((packed >>> 24) & 0xff) / 255;
      color.green = clampByte((packed >>> 16) & 0xff) / 255;
      color.blue = clampByte((packed >>> 8) & 0xff) / 255;
      color.alpha = clampByte(packed & 0xff) / 255;
    }

    this.writeInstance(x, y, width, height, uv, color);
  }

  get instanceCount(): number {
    return this.lengthFloats / INSTANCE_STRIDE_FLOATS;
  }

  get usedByteLength(): number {
    return this.lengthFloats * Float32Array.BYTES_PER_ELEMENT;
  }
}

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
  @location(2) uvRect: vec4<f32>,
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
  out.uvRect = input.instanceUvRect;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texSize = vec2<f32>(textureDimensions(spriteTexture));
  let halfTexel = vec2<f32>(0.5) / texSize;

  let uvRectMin = input.uvRect.xy;
  let uvRectMax = input.uvRect.zw;
  let uvRectSize = max(vec2<f32>(0.0), uvRectMax - uvRectMin);
  let inset = min(halfTexel, uvRectSize * 0.5);

  let uv = clamp(input.uv, uvRectMin + inset, uvRectMax - inset);
  let texel = textureSample(spriteTexture, spriteSampler, uv);
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

function isRenderableAtlasAssetKind(kind: string): boolean {
  return isRenderableImageAssetKind(kind) || kind === 'font';
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

interface WebGpuBitmapFontRuntimeGlyph {
  readonly uv: SpriteUvRect;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly xOffsetPx: number;
  readonly yOffsetPx: number;
  readonly xAdvancePx: number;
}

interface WebGpuBitmapFontRuntime {
  readonly baseFontSizePx: number;
  readonly lineHeightPx: number;
  readonly glyphByCodePoint: Map<number, WebGpuBitmapFontRuntimeGlyph>;
  readonly fallbackGlyph: WebGpuBitmapFontRuntimeGlyph | undefined;
}

function buildInsetUvRange(options: {
  readonly startPx: number;
  readonly sizePx: number;
  readonly atlasSizePx: number;
}): { readonly t0: number; readonly t1: number } {
  if (!Number.isFinite(options.atlasSizePx) || options.atlasSizePx <= 0) {
    return { t0: 0, t1: 0 };
  }

  if (!Number.isFinite(options.startPx) || !Number.isFinite(options.sizePx)) {
    return { t0: 0, t1: 0 };
  }

  const sizePx = Math.max(0, options.sizePx);
  return {
    t0: options.startPx / options.atlasSizePx,
    t1: (options.startPx + sizePx) / options.atlasSizePx,
  };
}

function buildInsetSpriteUvRect(options: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly atlasWidthPx: number;
  readonly atlasHeightPx: number;
}): SpriteUvRect {
  const u = buildInsetUvRange({
    startPx: options.x,
    sizePx: options.width,
    atlasSizePx: options.atlasWidthPx,
  });
  const v = buildInsetUvRange({
    startPx: options.y,
    sizePx: options.height,
    atlasSizePx: options.atlasHeightPx,
  });

  return {
    u0: u.t0,
    v0: v.t0,
    u1: u.t1,
    v1: v.t1,
  };
}

function buildBitmapFontRuntimeGlyph(options: {
  readonly glyph: WebGpuBitmapFontGlyph;
  readonly fontAssetId: AssetId;
  readonly fontSize: { readonly width: number; readonly height: number };
  readonly atlasEntry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly atlasWidthPx: number;
  readonly atlasHeightPx: number;
}): { readonly codePoint: number; readonly runtimeGlyph: WebGpuBitmapFontRuntimeGlyph } {
  const codePoint = options.glyph.codePoint;
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    throw new Error(
      `Font ${options.fontAssetId} has invalid glyph codePoint ${String(codePoint)}.`,
    );
  }

  const { x, y, width, height } = options.glyph;

  if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(
      `Font ${options.fontAssetId} glyph ${codePoint} has non-finite bounds.`,
    );
  }

  if (width < 0 || height < 0) {
    throw new Error(
      `Font ${options.fontAssetId} glyph ${codePoint} has negative size ${width}x${height}.`,
    );
  }

  if (x < 0 || y < 0 || x + width > options.fontSize.width || y + height > options.fontSize.height) {
    throw new Error(
      `Font ${options.fontAssetId} glyph ${codePoint} bounds exceed atlas image (${options.fontSize.width}x${options.fontSize.height}).`,
    );
  }

  const xOffsetPx = options.glyph.xOffsetPx;
  const yOffsetPx = options.glyph.yOffsetPx;
  const xAdvancePx = options.glyph.xAdvancePx;
  if (![xOffsetPx, yOffsetPx, xAdvancePx].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(
      `Font ${options.fontAssetId} glyph ${codePoint} has non-finite metrics.`,
    );
  }

  const atlasX0 = options.atlasEntry.x + x;
  const atlasY0 = options.atlasEntry.y + y;

  return {
    codePoint,
    runtimeGlyph: {
      uv: buildInsetSpriteUvRect({
        x: atlasX0,
        y: atlasY0,
        width,
        height,
        atlasWidthPx: options.atlasWidthPx,
        atlasHeightPx: options.atlasHeightPx,
      }),
      widthPx: width,
      heightPx: height,
      xOffsetPx,
      yOffsetPx,
      xAdvancePx,
    },
  };
}

function pickBitmapFontFallbackGlyph(options: {
  readonly font: WebGpuBitmapFont;
  readonly glyphByCodePoint: Map<number, WebGpuBitmapFontRuntimeGlyph>;
}): WebGpuBitmapFontRuntimeGlyph | undefined {
  const candidateFallbacks: number[] = [];
  if (options.font.fallbackCodePoint !== undefined) {
    candidateFallbacks.push(options.font.fallbackCodePoint);
  }
  candidateFallbacks.push(0xfffd, 0x3f);

  for (const codePoint of candidateFallbacks) {
    const glyph = options.glyphByCodePoint.get(codePoint);
    if (glyph) {
      return glyph;
    }
  }

  if (options.glyphByCodePoint.size === 0) {
    return undefined;
  }

  const sortedGlyphKeys = [...options.glyphByCodePoint.keys()].sort((a, b) => a - b);
  const firstKey = sortedGlyphKeys[0];
  return firstKey === undefined ? undefined : options.glyphByCodePoint.get(firstKey);
}

function buildBitmapFontRuntime(options: {
  readonly font: WebGpuBitmapFont;
  readonly fontAssetId: AssetId;
  readonly fontSize: { readonly width: number; readonly height: number };
  readonly atlasEntry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly atlasWidthPx: number;
  readonly atlasHeightPx: number;
}): WebGpuBitmapFontRuntime {
  const baseFontSizePx = options.font.baseFontSizePx;
  if (!Number.isFinite(baseFontSizePx) || baseFontSizePx <= 0) {
    throw new Error(
      `Font ${options.fontAssetId} has invalid baseFontSizePx ${String(baseFontSizePx)}.`,
    );
  }

  const lineHeightPx = options.font.lineHeightPx;
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
    throw new Error(
      `Font ${options.fontAssetId} has invalid lineHeightPx ${String(lineHeightPx)}.`,
    );
  }

  const glyphByCodePoint = new Map<number, WebGpuBitmapFontRuntimeGlyph>();

  for (const glyph of options.font.glyphs) {
    const { codePoint, runtimeGlyph } = buildBitmapFontRuntimeGlyph({
      glyph,
      fontAssetId: options.fontAssetId,
      fontSize: options.fontSize,
      atlasEntry: options.atlasEntry,
      atlasWidthPx: options.atlasWidthPx,
      atlasHeightPx: options.atlasHeightPx,
    });

    if (glyphByCodePoint.has(codePoint)) {
      throw new Error(`Font ${options.fontAssetId} contains duplicate glyph codePoint ${codePoint}.`);
    }

    glyphByCodePoint.set(codePoint, runtimeGlyph);
  }

  const fallbackGlyph = pickBitmapFontFallbackGlyph({ font: options.font, glyphByCodePoint });

  return {
    baseFontSizePx,
    lineHeightPx,
    glyphByCodePoint,
    fallbackGlyph,
  };
}

type ManifestAssetEntry = AssetManifest['assets'][number];

interface LoadedAtlasSource {
  readonly entry: ManifestAssetEntry;
  readonly source: GPUImageCopyExternalImageSource;
}

function getSortedRenderableAtlasEntries(manifest: AssetManifest): ManifestAssetEntry[] {
  const atlasEntries = manifest.assets
    .filter((entry) => isRenderableAtlasAssetKind(entry.kind))
    .slice()
    .sort((a, b) => compareAssetId(a.id, b.id));

  for (let index = 1; index < atlasEntries.length; index += 1) {
    const previous = atlasEntries[index - 1];
    const current = atlasEntries[index];
    if (previous && current && previous.id === current.id) {
      throw new Error(`AssetManifest contains duplicate AssetId: ${current.id}`);
    }
  }

  return atlasEntries;
}

async function loadAtlasSources(options: {
  readonly atlasEntries: readonly ManifestAssetEntry[];
  readonly assets: WebGpuRendererAssets;
}): Promise<{
  readonly loadedFontByAssetId: Map<AssetId, WebGpuBitmapFont>;
  readonly loadedSources: readonly LoadedAtlasSource[];
}> {
  const loadedFontByAssetId = new Map<AssetId, WebGpuBitmapFont>();
  const loadedSources: LoadedAtlasSource[] = [];

  for (const entry of options.atlasEntries) {
    if (entry.kind === 'font') {
      if (!options.assets.loadFont) {
        throw new Error(
          `AssetManifest contains font asset ${entry.id} but assets.loadFont is not provided.`,
        );
      }

      const font = await options.assets.loadFont(entry.id, entry.contentHash);
      loadedFontByAssetId.set(entry.id, font);
      loadedSources.push({ entry, source: font.image });
      continue;
    }

    loadedSources.push({
      entry,
      source: await options.assets.loadImage(entry.id, entry.contentHash),
    });
  }

  return { loadedFontByAssetId, loadedSources };
}

function buildAtlasImages(options: {
  readonly loadedSources: readonly LoadedAtlasSource[];
}): {
  readonly loadedFontSizeByAssetId: Map<AssetId, { width: number; height: number }>;
  readonly atlasImages: Array<{ assetId: AssetId; width: number; height: number }>;
} {
  const loadedFontSizeByAssetId = new Map<AssetId, { width: number; height: number }>();
  const atlasImages: Array<{ assetId: AssetId; width: number; height: number }> = [];

  for (const { entry, source } of options.loadedSources) {
    const size = getExternalImageSize(source);
    if (size.width <= 0 || size.height <= 0) {
      throw new Error(
        `Loaded image ${entry.id} has invalid dimensions ${size.width}x${size.height}.`,
      );
    }

    if (entry.kind === 'font') {
      loadedFontSizeByAssetId.set(entry.id, size);
    }

    atlasImages.push({
      assetId: entry.id,
      width: size.width,
      height: size.height,
    });
  }

  return { loadedFontSizeByAssetId, atlasImages };
}

type PackedAtlas = ReturnType<typeof packAtlas>;

function buildUvByAssetId(packed: PackedAtlas): Map<AssetId, SpriteUvRect> {
  const uvByAssetId = new Map<AssetId, SpriteUvRect>();
  for (const entry of packed.entries) {
    uvByAssetId.set(
      entry.assetId,
      buildInsetSpriteUvRect({
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
        atlasWidthPx: packed.atlasWidthPx,
        atlasHeightPx: packed.atlasHeightPx,
      }),
    );
  }
  return uvByAssetId;
}

function buildBitmapFontRuntimeState(options: {
  readonly packed: PackedAtlas;
  readonly loadedFontByAssetId: Map<AssetId, WebGpuBitmapFont>;
  readonly loadedFontSizeByAssetId: Map<AssetId, { width: number; height: number }>;
}): {
  readonly bitmapFontByAssetId: Map<AssetId, WebGpuBitmapFontRuntime> | undefined;
  readonly defaultBitmapFontAssetId: AssetId | undefined;
} {
  if (options.loadedFontByAssetId.size === 0) {
    return {
      bitmapFontByAssetId: undefined,
      defaultBitmapFontAssetId: undefined,
    };
  }

  const fontStateByAssetId = new Map<AssetId, WebGpuBitmapFontRuntime>();
  const atlasEntryByAssetId = new Map<AssetId, (typeof options.packed.entries)[number]>();
  for (const entry of options.packed.entries) {
    atlasEntryByAssetId.set(entry.assetId, entry);
  }

  const sortedFontAssetIds = [...options.loadedFontByAssetId.keys()].sort(compareAssetId);
  for (const fontAssetId of sortedFontAssetIds) {
    const font = options.loadedFontByAssetId.get(fontAssetId);
    const fontSize = options.loadedFontSizeByAssetId.get(fontAssetId);
    const atlasEntry = atlasEntryByAssetId.get(fontAssetId);

    if (!font || !fontSize || !atlasEntry) {
      throw new Error(`Missing font atlas data for asset ${fontAssetId}`);
    }

    fontStateByAssetId.set(
      fontAssetId,
      buildBitmapFontRuntime({
        font,
        fontAssetId,
        fontSize,
        atlasEntry,
        atlasWidthPx: options.packed.atlasWidthPx,
        atlasHeightPx: options.packed.atlasHeightPx,
      }),
    );
  }

  return {
    bitmapFontByAssetId: fontStateByAssetId,
    defaultBitmapFontAssetId: sortedFontAssetIds[0],
  };
}

type WebGpuQuadBatchKind = 'rect' | 'image';

interface WebGpuQuadRenderState {
  readonly passEncoder: GPURenderPassEncoder;
  readonly atlasUvByAssetId: ReadonlyMap<AssetId, SpriteUvRect> | undefined;
  readonly textureBindGroup: GPUBindGroup | undefined;
  readonly bitmapFontByAssetId: ReadonlyMap<AssetId, WebGpuBitmapFontRuntime> | undefined;
  readonly defaultBitmapFontAssetId: AssetId | undefined;

  readonly spritePipeline: GPURenderPipeline;
  readonly rectPipeline: GPURenderPipeline;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly worldGlobalsBindGroup: GPUBindGroup;
  readonly uiGlobalsBindGroup: GPUBindGroup;

  readonly viewportScissor: ScissorRect;

  appliedScissor: ScissorRect | undefined;
  currentPassId: RenderPassId | undefined;
  scissorStack: ScissorRect[];
  currentScissor: ScissorRect;

  batchKind: WebGpuQuadBatchKind | undefined;
  batchPassId: RenderPassId | undefined;
  batchInstances: QuadInstanceWriter;
}

function applyBitmapTextControlCharacter(
  char: string,
  pen: { x: number; y: number },
  lineHeightPx: number,
  tabAdvancePx: number,
): boolean {
  if (char === '\r') {
    return true;
  }
  if (char === '\n') {
    pen.x = 0;
    pen.y += lineHeightPx;
    return true;
  }
  if (char === '\t') {
    pen.x += tabAdvancePx;
    return true;
  }
  return false;
}

function appendBitmapTextInstances(options: {
  readonly batchInstances: QuadInstanceWriter;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly font: WebGpuBitmapFontRuntime;
  readonly scale: number;
  readonly tabAdvancePx: number;
  readonly color: QuadInstanceColor;
}): number {
  const pen = { x: 0, y: 0 };
  let appended = 0;

  options.batchInstances.reserveInstances(options.text.length);

  for (const glyphText of options.text) {
    if (applyBitmapTextControlCharacter(glyphText, pen, options.font.lineHeightPx, options.tabAdvancePx)) {
      continue;
    }

    const codePoint = glyphText.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    const glyph = options.font.glyphByCodePoint.get(codePoint) ?? options.font.fallbackGlyph;
    if (!glyph) {
      continue;
    }

    if (glyph.widthPx > 0 && glyph.heightPx > 0) {
      const glyphX = options.x + (pen.x + glyph.xOffsetPx) * options.scale;
      const glyphY = options.y + (pen.y + glyph.yOffsetPx) * options.scale;
      const glyphW = glyph.widthPx * options.scale;
      const glyphH = glyph.heightPx * options.scale;

      options.batchInstances.writeInstance(glyphX, glyphY, glyphW, glyphH, glyph.uv, options.color);
      appended += 1;
    }

    pen.x += glyph.xAdvancePx;
  }

  return appended;
}

class WebGpuRendererImpl implements WebGpuRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;

  readonly #alphaMode: GPUCanvasAlphaMode;
  readonly #onDeviceLost: ((error: WebGpuDeviceLostError) => void) | undefined;
  readonly #limits: WebGpuRendererResolvedLimits;
  #disposed = false;
  #lost = false;
  #devicePixelRatio = 1;
  #worldCamera: Camera2D = { x: 0, y: 0, zoom: 1 };
  readonly #worldFixedPointInvScale: number;

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
  readonly #retiredInstanceBuffers: GPUBuffer[] = [];
  #spriteTextureBindGroupLayout: GPUBindGroupLayout | undefined;
  #spriteTextureBindGroup: GPUBindGroup | undefined;
  #atlasTexture: GPUTexture | undefined;
  readonly #quadInstanceWriter = new QuadInstanceWriter();

  #atlasLayout: WebGpuAtlasLayout | undefined;
  #atlasLayoutHash: Sha256Hex | undefined;
  #atlasUvByAssetId: Map<AssetId, SpriteUvRect> | undefined;
  #bitmapFontByAssetId: Map<AssetId, WebGpuBitmapFontRuntime> | undefined;
  #defaultBitmapFontAssetId: AssetId | undefined;
  constructor(options: {
    canvas: HTMLCanvasElement;
    context: GPUCanvasContext;
    adapter: GPUAdapter;
    device: GPUDevice;
    format: GPUTextureFormat;
    alphaMode: GPUCanvasAlphaMode;
    limits: WebGpuRendererResolvedLimits;
    worldFixedPointScale?: number;
    onDeviceLost?: (error: WebGpuDeviceLostError) => void;
  }) {
    this.canvas = options.canvas;
    this.context = options.context;
    this.adapter = options.adapter;
    this.device = options.device;
    this.format = options.format;
    this.#alphaMode = options.alphaMode;
    this.#onDeviceLost = options.onDeviceLost;
    this.#limits = options.limits;

    const worldFixedPointScale = options.worldFixedPointScale ?? WORLD_FIXED_POINT_SCALE;
    if (!Number.isFinite(worldFixedPointScale) || worldFixedPointScale <= 0) {
      throw new Error('WebGPU renderer expected worldFixedPointScale to be a positive number.');
    }
    this.#worldFixedPointInvScale = 1 / worldFixedPointScale;

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

    const devicePixelRatio = options?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
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

  #assertReadyForAssetLoad(): void {
    if (this.#disposed) {
      throw new Error('WebGPU renderer is disposed.');
    }
    if (this.#lost) {
      throw new Error('WebGPU device is lost.');
    }
  }

  #assertSupportedAssetManifest(manifest: AssetManifest): void {
    if (manifest.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION) {
      throw new Error(
        `AssetManifest schemaVersion ${manifest.schemaVersion} is not supported. Expected ${RENDERER_CONTRACT_SCHEMA_VERSION}.`,
      );
    }

    if (manifest.assets.length > this.#limits.maxAssets) {
      throw new Error(
        `AssetManifest exceeds limits.maxAssets: ${manifest.assets.length} > ${this.#limits.maxAssets}.`,
      );
    }
  }

  #assertSupportedRenderCommandBuffer(rcb: RenderCommandBuffer): void {
    if (rcb.frame.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION) {
      throw new Error(
        `RenderCommandBuffer schemaVersion ${rcb.frame.schemaVersion} is not supported. Expected ${RENDERER_CONTRACT_SCHEMA_VERSION}.`,
      );
    }

    const scene = (rcb as unknown as { readonly scene?: unknown }).scene;
    if (!isRecord(scene)) {
      throw new Error('RenderCommandBuffer.scene must be an object.');
    }

    const camera = scene['camera'];
    if (!isRecord(camera)) {
      throw new Error('RenderCommandBuffer.scene.camera must be an object.');
    }

    const x = camera['x'];
    const y = camera['y'];
    const zoom = camera['zoom'];

    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new Error('RenderCommandBuffer.scene.camera.x must be a finite number.');
    }
    if (typeof y !== 'number' || !Number.isFinite(y)) {
      throw new Error('RenderCommandBuffer.scene.camera.y must be a finite number.');
    }
    if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) {
      throw new Error('RenderCommandBuffer.scene.camera.zoom must be a positive number.');
    }

    if (rcb.draws.length > this.#limits.maxDrawsPerFrame) {
      throw new Error(
        `RenderCommandBuffer exceeds limits.maxDrawsPerFrame: ${rcb.draws.length} > ${this.#limits.maxDrawsPerFrame}.`,
      );
    }

    if (this.#limits.maxTextLength > 0) {
      for (let index = 0; index < rcb.draws.length; index += 1) {
        const draw = rcb.draws[index];
        const text = (draw as unknown as { readonly text?: unknown }).text;
        if (typeof text !== 'string') {
          continue;
        }

        if (text.length > this.#limits.maxTextLength) {
          throw new Error(
            `RenderCommandBuffer exceeds limits.maxTextLength: draws[${index}].text.length ${text.length} > ${this.#limits.maxTextLength}.`,
          );
        }
      }
    }
  }

  #safeDestroyBuffer(buffer: GPUBuffer | undefined): void {
    if (!buffer) {
      return;
    }

    try {
      buffer.destroy();
    } catch {
      return;
    }
  }

  #safeDestroyTexture(texture: GPUTexture | undefined): void {
    if (!texture) {
      return;
    }

    try {
      texture.destroy();
    } catch {
      return;
    }
  }

  #flushRetiredInstanceBuffers(): void {
    if (this.#retiredInstanceBuffers.length === 0) {
      return;
    }

    for (const buffer of this.#retiredInstanceBuffers) {
      this.#safeDestroyBuffer(buffer);
    }

    this.#retiredInstanceBuffers.length = 0;
  }

  #createAtlasTextureAndUpload(options: {
    readonly packed: PackedAtlas;
    readonly loadedSources: readonly LoadedAtlasSource[];
  }): GPUTexture {
    const atlasTexture = this.device.createTexture({
      size: [options.packed.atlasWidthPx, options.packed.atlasHeightPx, 1],
      format: 'rgba8unorm',
      usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST,
    });

    const sourceByAssetId = new Map<AssetId, GPUImageCopyExternalImageSource>();
    for (const { entry, source } of options.loadedSources) {
      sourceByAssetId.set(entry.id, source);
    }

    for (const entry of options.packed.entries) {
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

    return atlasTexture;
  }

  #createSpriteAtlasBindGroup(atlasTexture: GPUTexture): GPUBindGroup {
    const atlasView = atlasTexture.createView();
    const textureBindGroupLayout = this.#spriteTextureBindGroupLayout;
    const sampler = this.#spriteSampler;
    if (!textureBindGroupLayout || !sampler) {
      throw new Error('Sprite pipeline missing texture bindings.');
    }

    return this.device.createBindGroup({
      layout: textureBindGroupLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: atlasView },
      ],
    });
  }

  async loadAssets(
    manifest: AssetManifest,
    assets: WebGpuRendererAssets,
    options?: WebGpuRendererLoadAssetsOptions,
  ): Promise<WebGpuRendererAtlasState> {
    this.#assertReadyForAssetLoad();
    this.#assertSupportedAssetManifest(manifest);

    this.#ensureSpritePipeline();

    const atlasEntries = getSortedRenderableAtlasEntries(manifest);
    const { loadedFontByAssetId, loadedSources } = await loadAtlasSources({
      atlasEntries,
      assets,
    });
    const { loadedFontSizeByAssetId, atlasImages } = buildAtlasImages({ loadedSources });

    const packed = packAtlas(atlasImages, {
      maxSizePx: options?.maxAtlasSizePx,
      paddingPx: options?.paddingPx,
      powerOfTwo: options?.powerOfTwo,
    });
    const layout = createAtlasLayout(packed);
    const layoutHash = await sha256Hex(canonicalEncodeForHash(layout));

    const previousAtlasTexture = this.#atlasTexture;
    const atlasTexture = this.#createAtlasTextureAndUpload({ packed, loadedSources });
    this.#spriteTextureBindGroup = this.#createSpriteAtlasBindGroup(atlasTexture);
    this.#atlasTexture = atlasTexture;
    this.#safeDestroyTexture(previousAtlasTexture);

    const uvByAssetId = buildUvByAssetId(packed);
    const { bitmapFontByAssetId, defaultBitmapFontAssetId } = buildBitmapFontRuntimeState({
      packed,
      loadedFontByAssetId,
      loadedFontSizeByAssetId,
    });
    this.#bitmapFontByAssetId = bitmapFontByAssetId;
    this.#defaultBitmapFontAssetId = defaultBitmapFontAssetId;

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
    const previousBuffer = this.#spriteInstanceBuffer;
    const nextBuffer = this.device.createBuffer({
      size,
      usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
    });
    this.#spriteInstanceBuffer = nextBuffer;
    this.#spriteInstanceBufferSize = size;
    if (previousBuffer) {
      this.#retiredInstanceBuffers.push(previousBuffer);
    }
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

  #getQuadPipelinesOrThrow(): {
    readonly spritePipeline: GPURenderPipeline;
    readonly rectPipeline: GPURenderPipeline;
    readonly vertexBuffer: GPUBuffer;
    readonly indexBuffer: GPUBuffer;
    readonly worldGlobalsBindGroup: GPUBindGroup;
    readonly uiGlobalsBindGroup: GPUBindGroup;
  } {
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

    return {
      spritePipeline,
      rectPipeline,
      vertexBuffer,
      indexBuffer,
      worldGlobalsBindGroup,
      uiGlobalsBindGroup,
    };
  }

  #createQuadRenderState(
    passEncoder: GPURenderPassEncoder,
    orderedDraws: readonly OrderedDraw[],
  ): WebGpuQuadRenderState | undefined {
    this.#quadInstanceWriter.reset();

    const hasQuadDraws = orderedDraws.some(
      (entry) =>
        entry.draw.kind === 'rect' ||
        entry.draw.kind === 'image' ||
        entry.draw.kind === 'text',
    );
    if (!hasQuadDraws) {
      return undefined;
    }

    const atlasUvByAssetId = this.#atlasUvByAssetId;
    const textureBindGroup = this.#spriteTextureBindGroup;
    const bitmapFontByAssetId = this.#bitmapFontByAssetId;
    const defaultBitmapFontAssetId = this.#defaultBitmapFontAssetId;

    const requiresSpriteAtlas = orderedDraws.some(
      (entry) => entry.draw.kind === 'image' || entry.draw.kind === 'text',
    );
    if (requiresSpriteAtlas && (!atlasUvByAssetId || !textureBindGroup)) {
      throw new Error(
        'No sprite atlas loaded. Call renderer.loadAssets(...) before rendering image/text draws.',
      );
    }

    const hasTextDraws = orderedDraws.some((entry) => entry.draw.kind === 'text');
    if (hasTextDraws && (!bitmapFontByAssetId || bitmapFontByAssetId.size === 0)) {
      throw new Error(
        'No bitmap fonts loaded. Include font assets in the manifest and implement assets.loadFont(...).',
      );
    }

    const pipelines = this.#getQuadPipelinesOrThrow();

    const viewportScissor: ScissorRect = {
      x: 0,
      y: 0,
      width: this.canvas.width,
      height: this.canvas.height,
    };

    return {
      passEncoder,
      atlasUvByAssetId,
      textureBindGroup,
      bitmapFontByAssetId,
      defaultBitmapFontAssetId,
      ...pipelines,
      viewportScissor,
      appliedScissor: undefined,
      currentPassId: undefined,
      scissorStack: [],
      currentScissor: viewportScissor,
      batchKind: undefined,
      batchPassId: undefined,
      batchInstances: this.#quadInstanceWriter,
    };
  }

  #applyScissorRect(state: WebGpuQuadRenderState, rect: ScissorRect): void {
    if (state.appliedScissor && isSameScissorRect(state.appliedScissor, rect)) {
      return;
    }

    state.passEncoder.setScissorRect(rect.x, rect.y, rect.width, rect.height);
    state.appliedScissor = rect;
  }

  #resetQuadBatch(state: WebGpuQuadRenderState): void {
    state.batchKind = undefined;
    state.batchPassId = undefined;
    state.batchInstances.reset();
  }

  #flushQuadBatch(state: WebGpuQuadRenderState): void {
    const kind = state.batchKind;
    const passId = state.batchPassId;
    const instanceCount = state.batchInstances.instanceCount;
    const usedBytes = state.batchInstances.usedByteLength;

    if (!kind || !passId || instanceCount <= 0 || usedBytes <= 0) {
      this.#resetQuadBatch(state);
      return;
    }

    if (state.currentScissor.width <= 0 || state.currentScissor.height <= 0) {
      this.#resetQuadBatch(state);
      return;
    }

    this.#ensureInstanceBuffer(usedBytes);

    const instanceBuffer = this.#spriteInstanceBuffer;
    if (!instanceBuffer) {
      throw new Error('Sprite pipeline missing instance buffer.');
    }

    this.device.queue.writeBuffer(instanceBuffer, 0, state.batchInstances.buffer, 0, usedBytes);

    const globals = passId === 'world' ? state.worldGlobalsBindGroup : state.uiGlobalsBindGroup;

    if (kind === 'image') {
      if (!state.textureBindGroup) {
        throw new Error('Sprite pipeline missing texture bind group.');
      }
      state.passEncoder.setPipeline(state.spritePipeline);
      state.passEncoder.setBindGroup(1, state.textureBindGroup);
    } else {
      state.passEncoder.setPipeline(state.rectPipeline);
    }

    state.passEncoder.setBindGroup(0, globals);
    state.passEncoder.setVertexBuffer(0, state.vertexBuffer);
    state.passEncoder.setVertexBuffer(1, instanceBuffer);
    state.passEncoder.setIndexBuffer(state.indexBuffer, 'uint16');
    state.passEncoder.drawIndexed(6, instanceCount, 0, 0, 0);

    this.#resetQuadBatch(state);
  }

  #ensureQuadBatch(
    state: WebGpuQuadRenderState,
    kind: WebGpuQuadBatchKind,
    passId: RenderPassId,
  ): void {
    if (state.batchKind === kind && state.batchPassId === passId) {
      return;
    }

    this.#flushQuadBatch(state);
    state.batchKind = kind;
    state.batchPassId = passId;
  }

  #setQuadPass(state: WebGpuQuadRenderState, passId: RenderPassId): void {
    if (state.currentPassId === passId) {
      return;
    }

    this.#flushQuadBatch(state);
    state.currentPassId = passId;
    state.scissorStack = [];
    state.currentScissor = state.viewportScissor;
    this.#applyScissorRect(state, state.currentScissor);
  }

  #spriteUvOrThrow(state: WebGpuQuadRenderState, assetId: AssetId): SpriteUvRect {
    const atlasUvByAssetId = state.atlasUvByAssetId;
    if (!atlasUvByAssetId) {
      throw new Error('Sprite atlas missing UVs.');
    }

    const uv = atlasUvByAssetId.get(assetId);
    if (!uv) {
      throw new Error(`Atlas missing UVs for AssetId: ${assetId}`);
    }

    return uv;
  }

  #renderQuadDrawEntry(state: WebGpuQuadRenderState, entry: OrderedDraw): void {
    this.#setQuadPass(state, entry.passId);

    const draw = entry.draw;
    switch (draw.kind) {
      case 'scissorPush':
        this.#handleScissorPushDraw(state, entry.passId, draw);
        break;
      case 'scissorPop':
        this.#handleScissorPopDraw(state);
        break;
      case 'rect':
        this.#handleRectDraw(state, entry.passId, draw);
        break;
      case 'image':
        this.#handleImageDraw(state, entry.passId, draw);
        break;
      case 'text':
        this.#handleTextDraw(state, entry.passId, draw);
        break;
      default:
        this.#flushQuadBatch(state);
        break;
    }
  }

  #handleScissorPushDraw(
    state: WebGpuQuadRenderState,
    passId: RenderPassId,
    draw: Extract<OrderedDraw['draw'], { kind: 'scissorPush' }>,
  ): void {
    this.#flushQuadBatch(state);
    const coordScale = passId === 'world' ? this.#worldFixedPointInvScale : 1;
    const scissor = this.#toDeviceScissorRect({
      passId,
      x: draw.x * coordScale,
      y: draw.y * coordScale,
      width: draw.width * coordScale,
      height: draw.height * coordScale,
    });
    state.scissorStack.push(state.currentScissor);
    state.currentScissor = intersectScissorRect(state.currentScissor, scissor);
    this.#applyScissorRect(state, state.currentScissor);
  }

  #handleScissorPopDraw(state: WebGpuQuadRenderState): void {
    this.#flushQuadBatch(state);
    state.currentScissor = state.scissorStack.pop() ?? state.viewportScissor;
    this.#applyScissorRect(state, state.currentScissor);
  }

  #handleRectDraw(
    state: WebGpuQuadRenderState,
    passId: RenderPassId,
    draw: Extract<OrderedDraw['draw'], { kind: 'rect' }>,
  ): void {
    this.#ensureQuadBatch(state, 'rect', passId);
    const coordScale = passId === 'world' ? this.#worldFixedPointInvScale : 1;
    state.batchInstances.writeInstanceRgba(
      draw.x * coordScale,
      draw.y * coordScale,
      draw.width * coordScale,
      draw.height * coordScale,
      ZERO_SPRITE_UV_RECT,
      draw.colorRgba,
    );
  }

  #handleImageDraw(
    state: WebGpuQuadRenderState,
    passId: RenderPassId,
    draw: Extract<OrderedDraw['draw'], { kind: 'image' }>,
  ): void {
    this.#ensureQuadBatch(state, 'image', passId);
    const coordScale = passId === 'world' ? this.#worldFixedPointInvScale : 1;

    const uv = this.#spriteUvOrThrow(state, draw.assetId);
    state.batchInstances.writeInstanceRgba(
      draw.x * coordScale,
      draw.y * coordScale,
      draw.width * coordScale,
      draw.height * coordScale,
      uv,
      draw.tintRgba,
    );
  }

  #handleTextDraw(
    state: WebGpuQuadRenderState,
    passId: RenderPassId,
    draw: Extract<OrderedDraw['draw'], { kind: 'text' }>,
  ): void {
    this.#ensureQuadBatch(state, 'image', passId);
    const coordScale = passId === 'world' ? this.#worldFixedPointInvScale : 1;

    const fontAssetId = draw.fontAssetId ?? state.defaultBitmapFontAssetId;
    if (!fontAssetId) {
      throw new Error('Text draw missing fontAssetId and no default font is available.');
    }

    const font = state.bitmapFontByAssetId?.get(fontAssetId);
    if (!font) {
      throw new Error(`Unknown fontAssetId: ${fontAssetId}`);
    }

    const scale = draw.fontSizePx / font.baseFontSizePx;
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error(`Invalid fontSizePx ${draw.fontSizePx} for font ${fontAssetId}.`);
    }

    const rgba = draw.colorRgba >>> 0;
    const red = clampByte((rgba >>> 24) & 0xff) / 255;
    const green = clampByte((rgba >>> 16) & 0xff) / 255;
    const blue = clampByte((rgba >>> 8) & 0xff) / 255;
    const alpha = clampByte(rgba & 0xff) / 255;

    const spaceGlyph = font.glyphByCodePoint.get(0x20) ?? font.fallbackGlyph;
    const tabAdvancePx = (spaceGlyph?.xAdvancePx ?? 0) * 4;

    appendBitmapTextInstances({
      batchInstances: state.batchInstances,
      x: draw.x * coordScale,
      y: draw.y * coordScale,
      text: draw.text,
      font,
      scale,
      tabAdvancePx,
      color: { red, green, blue, alpha },
    });
  }

  #renderDraws(passEncoder: GPURenderPassEncoder, orderedDraws: readonly OrderedDraw[]): void {
    const state = this.#createQuadRenderState(passEncoder, orderedDraws);
    if (!state) {
      return;
    }

    this.#writeGlobals(WORLD_GLOBALS_OFFSET, this.#worldCamera);
    this.#writeGlobals(UI_GLOBALS_OFFSET, { x: 0, y: 0, zoom: 1 });

    this.#applyScissorRect(state, state.viewportScissor);

    for (const entry of orderedDraws) {
      this.#renderQuadDrawEntry(state, entry);
    }

    this.#flushQuadBatch(state);
  }

  render(rcb: RenderCommandBuffer): void {
    if (this.#disposed || this.#lost) {
      return;
    }

    this.#assertSupportedRenderCommandBuffer(rcb);
    this.#worldCamera = rcb.scene.camera;

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

    try {
      const orderedDraws = orderDrawsByPassAndSortKey(rcb);
      this.#renderDraws(passEncoder, orderedDraws);

      passEncoder.end();

      this.device.queue.submit([commandEncoder.finish()]);
    } finally {
      this.#flushRetiredInstanceBuffers();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;

    this.#safeDestroyTexture(this.#atlasTexture);
    this.#atlasTexture = undefined;
    this.#spriteTextureBindGroup = undefined;
    this.#spriteTextureBindGroupLayout = undefined;

    this.#flushRetiredInstanceBuffers();
    this.#safeDestroyBuffer(this.#spriteInstanceBuffer);
    this.#spriteInstanceBuffer = undefined;
    this.#spriteInstanceBufferSize = 0;
    this.#safeDestroyBuffer(this.#spriteIndexBuffer);
    this.#spriteIndexBuffer = undefined;
    this.#safeDestroyBuffer(this.#spriteVertexBuffer);
    this.#spriteVertexBuffer = undefined;
    this.#safeDestroyBuffer(this.#spriteUniformBuffer);
    this.#spriteUniformBuffer = undefined;
    this.#worldGlobalsBindGroup = undefined;
    this.#uiGlobalsBindGroup = undefined;

    this.#spritePipeline = undefined;
    this.#rectPipeline = undefined;
    this.#spriteSampler = undefined;

    this.#atlasLayout = undefined;
    this.#atlasLayoutHash = undefined;
    this.#atlasUvByAssetId = undefined;
    this.#bitmapFontByAssetId = undefined;
    this.#defaultBitmapFontAssetId = undefined;
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
    limits: resolveWebGpuRendererLimits(options?.limits),
    worldFixedPointScale: options?.worldFixedPointScale,
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
