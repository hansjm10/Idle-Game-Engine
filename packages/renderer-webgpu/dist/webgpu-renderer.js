var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var _QuadInstanceWriter_scratchColor, _WebGpuRendererImpl_instances, _WebGpuRendererImpl_alphaMode, _WebGpuRendererImpl_onDeviceLost, _WebGpuRendererImpl_limits, _WebGpuRendererImpl_disposed, _WebGpuRendererImpl_lost, _WebGpuRendererImpl_devicePixelRatio, _WebGpuRendererImpl_worldCamera, _WebGpuRendererImpl_worldFixedPointInvScale, _WebGpuRendererImpl_spritePipeline, _WebGpuRendererImpl_rectPipeline, _WebGpuRendererImpl_spriteSampler, _WebGpuRendererImpl_spriteUniformBuffer, _WebGpuRendererImpl_worldGlobalsBindGroup, _WebGpuRendererImpl_uiGlobalsBindGroup, _WebGpuRendererImpl_spriteVertexBuffer, _WebGpuRendererImpl_spriteIndexBuffer, _WebGpuRendererImpl_spriteInstanceBuffer, _WebGpuRendererImpl_spriteInstanceBufferSize, _WebGpuRendererImpl_retiredInstanceBuffers, _WebGpuRendererImpl_spriteTextureBindGroupLayout, _WebGpuRendererImpl_spriteTextureBindGroup, _WebGpuRendererImpl_atlasTexture, _WebGpuRendererImpl_quadInstanceWriter, _WebGpuRendererImpl_atlasLayout, _WebGpuRendererImpl_atlasLayoutHash, _WebGpuRendererImpl_atlasUvByAssetId, _WebGpuRendererImpl_bitmapFontByAssetId, _WebGpuRendererImpl_defaultBitmapFontAssetId, _WebGpuRendererImpl_assertReadyForAssetLoad, _WebGpuRendererImpl_assertSupportedAssetManifest, _WebGpuRendererImpl_assertTextLengthWithinLimits, _WebGpuRendererImpl_assertSupportedRenderCommandBuffer, _WebGpuRendererImpl_safeDestroyBuffer, _WebGpuRendererImpl_safeDestroyTexture, _WebGpuRendererImpl_flushRetiredInstanceBuffers, _WebGpuRendererImpl_createAtlasTextureAndUpload, _WebGpuRendererImpl_createSpriteAtlasBindGroup, _WebGpuRendererImpl_ensureSpritePipeline, _WebGpuRendererImpl_ensureInstanceBuffer, _WebGpuRendererImpl_writeGlobals, _WebGpuRendererImpl_toDeviceScissorRect, _WebGpuRendererImpl_getQuadPipelinesOrThrow, _WebGpuRendererImpl_createQuadRenderState, _WebGpuRendererImpl_applyScissorRect, _WebGpuRendererImpl_resetQuadBatch, _WebGpuRendererImpl_flushQuadBatch, _WebGpuRendererImpl_ensureQuadBatch, _WebGpuRendererImpl_setQuadPass, _WebGpuRendererImpl_spriteUvOrThrow, _WebGpuRendererImpl_renderQuadDrawEntry, _WebGpuRendererImpl_handleScissorPushDraw, _WebGpuRendererImpl_handleScissorPopDraw, _WebGpuRendererImpl_handleRectDraw, _WebGpuRendererImpl_handleImageDraw, _WebGpuRendererImpl_handleTextDraw, _WebGpuRendererImpl_renderDraws;
import { RENDERER_CONTRACT_SCHEMA_VERSION, WORLD_FIXED_POINT_SCALE, canonicalEncodeForHash, sha256Hex, } from '@idle-engine/renderer-contract';
import { createAtlasLayout, packAtlas, } from './atlas-packer.js';
import { orderDrawsByPassAndSortKey, } from './sprite-batching.js';
export class WebGpuNotSupportedError extends Error {
    constructor() {
        super(...arguments);
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'WebGpuNotSupportedError'
        });
    }
}
export class WebGpuDeviceLostError extends Error {
    constructor(message, reason) {
        super(message);
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'WebGpuDeviceLostError'
        });
        Object.defineProperty(this, "reason", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.reason = reason;
    }
}
const DEFAULT_WEBGPU_RENDERER_LIMITS = {
    maxAssets: 10000,
    maxDrawsPerFrame: 100000,
    maxTextLength: 10000,
};
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function clampByte(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(255, Math.max(0, Math.floor(value)));
}
function colorRgbaToGpuColor(colorRgba) {
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
function selectClearColor(rcb) {
    const primaryPassId = rcb.passes[0]?.id;
    const clearDrawByPass = primaryPassId === undefined
        ? undefined
        : rcb.draws.find((draw) => draw.kind === 'clear' && draw.passId === primaryPassId);
    const clearDrawCandidate = clearDrawByPass ?? rcb.draws.find((draw) => draw.kind === 'clear');
    if (clearDrawCandidate?.kind !== 'clear') {
        return { r: 0, g: 0, b: 0, a: 1 };
    }
    return colorRgbaToGpuColor(clearDrawCandidate.colorRgba);
}
function getCanvasPixelSize(canvas, devicePixelRatio) {
    const targetWidth = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
    const targetHeight = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
    return { width: targetWidth, height: targetHeight };
}
function configureCanvasContext(options) {
    try {
        options.context.configure({
            device: options.device,
            format: options.format,
            alphaMode: options.alphaMode,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WebGpuNotSupportedError(`Failed to configure WebGPU canvas context (format: ${options.format})${message ? `: ${message}` : ''}`);
    }
}
function parsePositiveIntegerLimit(value, fallback, path) {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error(`WebGPU renderer expected ${path} to be a positive integer.`);
    }
    return value;
}
function resolveWebGpuRendererLimits(limits) {
    return {
        maxAssets: parsePositiveIntegerLimit(limits?.maxAssets, DEFAULT_WEBGPU_RENDERER_LIMITS.maxAssets, 'limits.maxAssets'),
        maxDrawsPerFrame: parsePositiveIntegerLimit(limits?.maxDrawsPerFrame, DEFAULT_WEBGPU_RENDERER_LIMITS.maxDrawsPerFrame, 'limits.maxDrawsPerFrame'),
        maxTextLength: parsePositiveIntegerLimit(limits?.maxTextLength, DEFAULT_WEBGPU_RENDERER_LIMITS.maxTextLength, 'limits.maxTextLength'),
    };
}
function isSameScissorRect(a, b) {
    return (a.x === b.x &&
        a.y === b.y &&
        a.width === b.width &&
        a.height === b.height);
}
function intersectScissorRect(a, b) {
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
const ZERO_SPRITE_UV_RECT = { u0: 0, v0: 0, u1: 0, v1: 0 };
class QuadInstanceWriter {
    constructor(initialCapacityFloats = 0) {
        Object.defineProperty(this, "buffer", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "lengthFloats", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        _QuadInstanceWriter_scratchColor.set(this, { red: 1, green: 1, blue: 1, alpha: 1 });
        this.buffer = new Float32Array(initialCapacityFloats);
    }
    reset() {
        this.lengthFloats = 0;
    }
    reserveInstances(additionalInstances) {
        if (additionalInstances <= 0) {
            return;
        }
        this.ensureCapacity(this.lengthFloats + additionalInstances * INSTANCE_STRIDE_FLOATS);
    }
    ensureCapacity(requiredFloats) {
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
    writeInstance(x, y, width, height, uv, color) {
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
    writeInstanceRgba(x, y, width, height, uv, rgba) {
        const color = __classPrivateFieldGet(this, _QuadInstanceWriter_scratchColor, "f");
        if (rgba === undefined) {
            color.red = 1;
            color.green = 1;
            color.blue = 1;
            color.alpha = 1;
        }
        else {
            const packed = rgba >>> 0;
            color.red = clampByte((packed >>> 24) & 0xff) / 255;
            color.green = clampByte((packed >>> 16) & 0xff) / 255;
            color.blue = clampByte((packed >>> 8) & 0xff) / 255;
            color.alpha = clampByte(packed & 0xff) / 255;
        }
        this.writeInstance(x, y, width, height, uv, color);
    }
    get instanceCount() {
        return this.lengthFloats / INSTANCE_STRIDE_FLOATS;
    }
    get usedByteLength() {
        return this.lengthFloats * Float32Array.BYTES_PER_ELEMENT;
    }
}
_QuadInstanceWriter_scratchColor = new WeakMap();
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
function getExternalImageSize(source) {
    const record = source;
    const width = pickFiniteNumber(record, ['width', 'naturalWidth', 'videoWidth', 'codedWidth']) ?? 0;
    const height = pickFiniteNumber(record, ['height', 'naturalHeight', 'videoHeight', 'codedHeight']) ?? 0;
    return { width: Math.floor(width), height: Math.floor(height) };
}
function pickFiniteNumber(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}
function toArrayBuffer(view) {
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
function isRenderableImageAssetKind(kind) {
    return kind === 'image' || kind === 'spriteSheet';
}
function isRenderableAtlasAssetKind(kind) {
    return isRenderableImageAssetKind(kind) || kind === 'font';
}
function compareAssetId(a, b) {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}
const GPU_SHADER_STAGE = globalThis
    .GPUShaderStage ?? { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const GPU_BUFFER_USAGE = globalThis
    .GPUBufferUsage ?? {
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
};
const GPU_TEXTURE_USAGE = globalThis
    .GPUTextureUsage ?? { COPY_DST: 2, TEXTURE_BINDING: 4 };
function buildInsetUvRange(options) {
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
function buildInsetSpriteUvRect(options) {
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
function buildBitmapFontRuntimeGlyph(options) {
    const codePoint = options.glyph.codePoint;
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error(`Font ${options.fontAssetId} has invalid glyph codePoint ${String(codePoint)}.`);
    }
    const { x, y, width, height } = options.glyph;
    if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(`Font ${options.fontAssetId} glyph ${codePoint} has non-finite bounds.`);
    }
    if (width < 0 || height < 0) {
        throw new Error(`Font ${options.fontAssetId} glyph ${codePoint} has negative size ${width}x${height}.`);
    }
    if (x < 0 || y < 0 || x + width > options.fontSize.width || y + height > options.fontSize.height) {
        throw new Error(`Font ${options.fontAssetId} glyph ${codePoint} bounds exceed atlas image (${options.fontSize.width}x${options.fontSize.height}).`);
    }
    const xOffsetPx = options.glyph.xOffsetPx;
    const yOffsetPx = options.glyph.yOffsetPx;
    const xAdvancePx = options.glyph.xAdvancePx;
    if (![xOffsetPx, yOffsetPx, xAdvancePx].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error(`Font ${options.fontAssetId} glyph ${codePoint} has non-finite metrics.`);
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
function pickBitmapFontFallbackGlyph(options) {
    const candidateFallbacks = [];
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
function buildBitmapFontRuntime(options) {
    const baseFontSizePx = options.font.baseFontSizePx;
    if (!Number.isFinite(baseFontSizePx) || baseFontSizePx <= 0) {
        throw new Error(`Font ${options.fontAssetId} has invalid baseFontSizePx ${String(baseFontSizePx)}.`);
    }
    const lineHeightPx = options.font.lineHeightPx;
    if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
        throw new Error(`Font ${options.fontAssetId} has invalid lineHeightPx ${String(lineHeightPx)}.`);
    }
    const glyphByCodePoint = new Map();
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
function getSortedRenderableAtlasEntries(manifest) {
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
async function loadAtlasSources(options) {
    const loadedFontByAssetId = new Map();
    const loadedSources = [];
    for (const entry of options.atlasEntries) {
        if (entry.kind === 'font') {
            if (!options.assets.loadFont) {
                throw new Error(`AssetManifest contains font asset ${entry.id} but assets.loadFont is not provided.`);
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
function buildAtlasImages(options) {
    const loadedFontSizeByAssetId = new Map();
    const atlasImages = [];
    for (const { entry, source } of options.loadedSources) {
        const size = getExternalImageSize(source);
        if (size.width <= 0 || size.height <= 0) {
            throw new Error(`Loaded image ${entry.id} has invalid dimensions ${size.width}x${size.height}.`);
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
function buildUvByAssetId(packed) {
    const uvByAssetId = new Map();
    for (const entry of packed.entries) {
        uvByAssetId.set(entry.assetId, buildInsetSpriteUvRect({
            x: entry.x,
            y: entry.y,
            width: entry.width,
            height: entry.height,
            atlasWidthPx: packed.atlasWidthPx,
            atlasHeightPx: packed.atlasHeightPx,
        }));
    }
    return uvByAssetId;
}
function buildBitmapFontRuntimeState(options) {
    if (options.loadedFontByAssetId.size === 0) {
        return {
            bitmapFontByAssetId: undefined,
            defaultBitmapFontAssetId: undefined,
        };
    }
    const fontStateByAssetId = new Map();
    const atlasEntryByAssetId = new Map();
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
        fontStateByAssetId.set(fontAssetId, buildBitmapFontRuntime({
            font,
            fontAssetId,
            fontSize,
            atlasEntry,
            atlasWidthPx: options.packed.atlasWidthPx,
            atlasHeightPx: options.packed.atlasHeightPx,
        }));
    }
    return {
        bitmapFontByAssetId: fontStateByAssetId,
        defaultBitmapFontAssetId: sortedFontAssetIds[0],
    };
}
function applyBitmapTextControlCharacter(char, pen, lineHeightPx, tabAdvancePx) {
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
function appendBitmapTextInstances(options) {
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
class WebGpuRendererImpl {
    constructor(options) {
        _WebGpuRendererImpl_instances.add(this);
        Object.defineProperty(this, "canvas", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "context", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "adapter", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "device", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "format", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        _WebGpuRendererImpl_alphaMode.set(this, void 0);
        _WebGpuRendererImpl_onDeviceLost.set(this, void 0);
        _WebGpuRendererImpl_limits.set(this, void 0);
        _WebGpuRendererImpl_disposed.set(this, false);
        _WebGpuRendererImpl_lost.set(this, false);
        _WebGpuRendererImpl_devicePixelRatio.set(this, 1);
        _WebGpuRendererImpl_worldCamera.set(this, { x: 0, y: 0, zoom: 1 });
        _WebGpuRendererImpl_worldFixedPointInvScale.set(this, void 0);
        _WebGpuRendererImpl_spritePipeline.set(this, void 0);
        _WebGpuRendererImpl_rectPipeline.set(this, void 0);
        _WebGpuRendererImpl_spriteSampler.set(this, void 0);
        _WebGpuRendererImpl_spriteUniformBuffer.set(this, void 0);
        _WebGpuRendererImpl_worldGlobalsBindGroup.set(this, void 0);
        _WebGpuRendererImpl_uiGlobalsBindGroup.set(this, void 0);
        _WebGpuRendererImpl_spriteVertexBuffer.set(this, void 0);
        _WebGpuRendererImpl_spriteIndexBuffer.set(this, void 0);
        _WebGpuRendererImpl_spriteInstanceBuffer.set(this, void 0);
        _WebGpuRendererImpl_spriteInstanceBufferSize.set(this, 0);
        _WebGpuRendererImpl_retiredInstanceBuffers.set(this, []);
        _WebGpuRendererImpl_spriteTextureBindGroupLayout.set(this, void 0);
        _WebGpuRendererImpl_spriteTextureBindGroup.set(this, void 0);
        _WebGpuRendererImpl_atlasTexture.set(this, void 0);
        _WebGpuRendererImpl_quadInstanceWriter.set(this, new QuadInstanceWriter());
        _WebGpuRendererImpl_atlasLayout.set(this, void 0);
        _WebGpuRendererImpl_atlasLayoutHash.set(this, void 0);
        _WebGpuRendererImpl_atlasUvByAssetId.set(this, void 0);
        _WebGpuRendererImpl_bitmapFontByAssetId.set(this, void 0);
        _WebGpuRendererImpl_defaultBitmapFontAssetId.set(this, void 0);
        this.canvas = options.canvas;
        this.context = options.context;
        this.adapter = options.adapter;
        this.device = options.device;
        this.format = options.format;
        __classPrivateFieldSet(this, _WebGpuRendererImpl_alphaMode, options.alphaMode, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_onDeviceLost, options.onDeviceLost, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_limits, options.limits, "f");
        const worldFixedPointScale = options.worldFixedPointScale ?? WORLD_FIXED_POINT_SCALE;
        if (!Number.isFinite(worldFixedPointScale) || worldFixedPointScale <= 0) {
            throw new Error('WebGPU renderer expected worldFixedPointScale to be a positive number.');
        }
        __classPrivateFieldSet(this, _WebGpuRendererImpl_worldFixedPointInvScale, 1 / worldFixedPointScale, "f");
        this.device.lost
            .then((info) => {
            if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f")) {
                return;
            }
            __classPrivateFieldSet(this, _WebGpuRendererImpl_lost, true, "f");
            const message = info.message ? `WebGPU device lost: ${info.message}` : 'WebGPU device lost';
            __classPrivateFieldGet(this, _WebGpuRendererImpl_onDeviceLost, "f")?.call(this, new WebGpuDeviceLostError(message, info.reason));
        })
            .catch(() => undefined);
    }
    get atlasLayout() {
        return __classPrivateFieldGet(this, _WebGpuRendererImpl_atlasLayout, "f");
    }
    get atlasLayoutHash() {
        return __classPrivateFieldGet(this, _WebGpuRendererImpl_atlasLayoutHash, "f");
    }
    resize(options) {
        if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f") || __classPrivateFieldGet(this, _WebGpuRendererImpl_lost, "f")) {
            return;
        }
        const devicePixelRatio = options?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
        __classPrivateFieldSet(this, _WebGpuRendererImpl_devicePixelRatio, devicePixelRatio, "f");
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
            alphaMode: __classPrivateFieldGet(this, _WebGpuRendererImpl_alphaMode, "f"),
        });
    }
    async loadAssets(manifest, assets, options) {
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_assertReadyForAssetLoad).call(this);
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_assertSupportedAssetManifest).call(this, manifest);
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_ensureSpritePipeline).call(this);
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
        const previousAtlasTexture = __classPrivateFieldGet(this, _WebGpuRendererImpl_atlasTexture, "f");
        const atlasTexture = __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_createAtlasTextureAndUpload).call(this, { packed, loadedSources });
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteTextureBindGroup, __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_createSpriteAtlasBindGroup).call(this, atlasTexture), "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasTexture, atlasTexture, "f");
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_safeDestroyTexture).call(this, previousAtlasTexture);
        const uvByAssetId = buildUvByAssetId(packed);
        const { bitmapFontByAssetId, defaultBitmapFontAssetId } = buildBitmapFontRuntimeState({
            packed,
            loadedFontByAssetId,
            loadedFontSizeByAssetId,
        });
        __classPrivateFieldSet(this, _WebGpuRendererImpl_bitmapFontByAssetId, bitmapFontByAssetId, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_defaultBitmapFontAssetId, defaultBitmapFontAssetId, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasLayout, layout, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasLayoutHash, layoutHash, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasUvByAssetId, uvByAssetId, "f");
        return { layout, layoutHash };
    }
    setWorldCamera(camera) {
        __classPrivateFieldSet(this, _WebGpuRendererImpl_worldCamera, camera, "f");
    }
    render(rcb) {
        if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f") || __classPrivateFieldGet(this, _WebGpuRendererImpl_lost, "f")) {
            return;
        }
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_assertSupportedRenderCommandBuffer).call(this, rcb);
        __classPrivateFieldSet(this, _WebGpuRendererImpl_worldCamera, rcb.scene.camera, "f");
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
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_renderDraws).call(this, passEncoder, orderedDraws);
            passEncoder.end();
            this.device.queue.submit([commandEncoder.finish()]);
        }
        finally {
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushRetiredInstanceBuffers).call(this);
        }
    }
    dispose() {
        if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f")) {
            return;
        }
        __classPrivateFieldSet(this, _WebGpuRendererImpl_disposed, true, "f");
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_safeDestroyTexture).call(this, __classPrivateFieldGet(this, _WebGpuRendererImpl_atlasTexture, "f"));
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasTexture, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteTextureBindGroup, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteTextureBindGroupLayout, undefined, "f");
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushRetiredInstanceBuffers).call(this);
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_safeDestroyBuffer).call(this, __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteInstanceBuffer, "f"));
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteInstanceBuffer, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteInstanceBufferSize, 0, "f");
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_safeDestroyBuffer).call(this, __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteIndexBuffer, "f"));
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteIndexBuffer, undefined, "f");
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_safeDestroyBuffer).call(this, __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteVertexBuffer, "f"));
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteVertexBuffer, undefined, "f");
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_safeDestroyBuffer).call(this, __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteUniformBuffer, "f"));
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteUniformBuffer, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_worldGlobalsBindGroup, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_uiGlobalsBindGroup, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spritePipeline, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_rectPipeline, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteSampler, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasLayout, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasLayoutHash, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_atlasUvByAssetId, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_bitmapFontByAssetId, undefined, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_defaultBitmapFontAssetId, undefined, "f");
    }
}
_WebGpuRendererImpl_alphaMode = new WeakMap(), _WebGpuRendererImpl_onDeviceLost = new WeakMap(), _WebGpuRendererImpl_limits = new WeakMap(), _WebGpuRendererImpl_disposed = new WeakMap(), _WebGpuRendererImpl_lost = new WeakMap(), _WebGpuRendererImpl_devicePixelRatio = new WeakMap(), _WebGpuRendererImpl_worldCamera = new WeakMap(), _WebGpuRendererImpl_worldFixedPointInvScale = new WeakMap(), _WebGpuRendererImpl_spritePipeline = new WeakMap(), _WebGpuRendererImpl_rectPipeline = new WeakMap(), _WebGpuRendererImpl_spriteSampler = new WeakMap(), _WebGpuRendererImpl_spriteUniformBuffer = new WeakMap(), _WebGpuRendererImpl_worldGlobalsBindGroup = new WeakMap(), _WebGpuRendererImpl_uiGlobalsBindGroup = new WeakMap(), _WebGpuRendererImpl_spriteVertexBuffer = new WeakMap(), _WebGpuRendererImpl_spriteIndexBuffer = new WeakMap(), _WebGpuRendererImpl_spriteInstanceBuffer = new WeakMap(), _WebGpuRendererImpl_spriteInstanceBufferSize = new WeakMap(), _WebGpuRendererImpl_retiredInstanceBuffers = new WeakMap(), _WebGpuRendererImpl_spriteTextureBindGroupLayout = new WeakMap(), _WebGpuRendererImpl_spriteTextureBindGroup = new WeakMap(), _WebGpuRendererImpl_atlasTexture = new WeakMap(), _WebGpuRendererImpl_quadInstanceWriter = new WeakMap(), _WebGpuRendererImpl_atlasLayout = new WeakMap(), _WebGpuRendererImpl_atlasLayoutHash = new WeakMap(), _WebGpuRendererImpl_atlasUvByAssetId = new WeakMap(), _WebGpuRendererImpl_bitmapFontByAssetId = new WeakMap(), _WebGpuRendererImpl_defaultBitmapFontAssetId = new WeakMap(), _WebGpuRendererImpl_instances = new WeakSet(), _WebGpuRendererImpl_assertReadyForAssetLoad = function _WebGpuRendererImpl_assertReadyForAssetLoad() {
    if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f")) {
        throw new Error('WebGPU renderer is disposed.');
    }
    if (__classPrivateFieldGet(this, _WebGpuRendererImpl_lost, "f")) {
        throw new Error('WebGPU device is lost.');
    }
}, _WebGpuRendererImpl_assertSupportedAssetManifest = function _WebGpuRendererImpl_assertSupportedAssetManifest(manifest) {
    if (manifest.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION) {
        throw new Error(`AssetManifest schemaVersion ${manifest.schemaVersion} is not supported. Expected ${RENDERER_CONTRACT_SCHEMA_VERSION}.`);
    }
    if (manifest.assets.length > __classPrivateFieldGet(this, _WebGpuRendererImpl_limits, "f").maxAssets) {
        throw new Error(`AssetManifest exceeds limits.maxAssets: ${manifest.assets.length} > ${__classPrivateFieldGet(this, _WebGpuRendererImpl_limits, "f").maxAssets}.`);
    }
}, _WebGpuRendererImpl_assertTextLengthWithinLimits = function _WebGpuRendererImpl_assertTextLengthWithinLimits(draws) {
    if (__classPrivateFieldGet(this, _WebGpuRendererImpl_limits, "f").maxTextLength <= 0) {
        return;
    }
    for (let index = 0; index < draws.length; index += 1) {
        const draw = draws[index];
        const text = draw.text;
        if (typeof text !== 'string') {
            continue;
        }
        if (text.length > __classPrivateFieldGet(this, _WebGpuRendererImpl_limits, "f").maxTextLength) {
            throw new Error(`RenderCommandBuffer exceeds limits.maxTextLength: draws[${index}].text.length ${text.length} > ${__classPrivateFieldGet(this, _WebGpuRendererImpl_limits, "f").maxTextLength}.`);
        }
    }
}, _WebGpuRendererImpl_assertSupportedRenderCommandBuffer = function _WebGpuRendererImpl_assertSupportedRenderCommandBuffer(rcb) {
    if (rcb.frame.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION) {
        throw new Error(`RenderCommandBuffer schemaVersion ${rcb.frame.schemaVersion} is not supported. Expected ${RENDERER_CONTRACT_SCHEMA_VERSION}.`);
    }
    const scene = rcb.scene;
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
        throw new TypeError('RenderCommandBuffer.scene.camera.x must be a finite number.');
    }
    if (typeof y !== 'number' || !Number.isFinite(y)) {
        throw new TypeError('RenderCommandBuffer.scene.camera.y must be a finite number.');
    }
    if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) {
        throw new Error('RenderCommandBuffer.scene.camera.zoom must be a positive number.');
    }
    if (rcb.draws.length > __classPrivateFieldGet(this, _WebGpuRendererImpl_limits, "f").maxDrawsPerFrame) {
        throw new Error(`RenderCommandBuffer exceeds limits.maxDrawsPerFrame: ${rcb.draws.length} > ${__classPrivateFieldGet(this, _WebGpuRendererImpl_limits, "f").maxDrawsPerFrame}.`);
    }
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_assertTextLengthWithinLimits).call(this, rcb.draws);
}, _WebGpuRendererImpl_safeDestroyBuffer = function _WebGpuRendererImpl_safeDestroyBuffer(buffer) {
    if (!buffer) {
        return;
    }
    try {
        buffer.destroy();
    }
    catch {
        return;
    }
}, _WebGpuRendererImpl_safeDestroyTexture = function _WebGpuRendererImpl_safeDestroyTexture(texture) {
    if (!texture) {
        return;
    }
    try {
        texture.destroy();
    }
    catch {
        return;
    }
}, _WebGpuRendererImpl_flushRetiredInstanceBuffers = function _WebGpuRendererImpl_flushRetiredInstanceBuffers() {
    if (__classPrivateFieldGet(this, _WebGpuRendererImpl_retiredInstanceBuffers, "f").length === 0) {
        return;
    }
    for (const buffer of __classPrivateFieldGet(this, _WebGpuRendererImpl_retiredInstanceBuffers, "f")) {
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_safeDestroyBuffer).call(this, buffer);
    }
    __classPrivateFieldGet(this, _WebGpuRendererImpl_retiredInstanceBuffers, "f").length = 0;
}, _WebGpuRendererImpl_createAtlasTextureAndUpload = function _WebGpuRendererImpl_createAtlasTextureAndUpload(options) {
    const atlasTexture = this.device.createTexture({
        size: [options.packed.atlasWidthPx, options.packed.atlasHeightPx, 1],
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST,
    });
    const sourceByAssetId = new Map();
    for (const { entry, source } of options.loadedSources) {
        sourceByAssetId.set(entry.id, source);
    }
    for (const entry of options.packed.entries) {
        const source = sourceByAssetId.get(entry.assetId);
        if (!source) {
            throw new Error(`Missing loaded image for AssetId: ${entry.assetId}`);
        }
        this.device.queue.copyExternalImageToTexture({ source }, {
            texture: atlasTexture,
            origin: { x: entry.x, y: entry.y },
        }, { width: entry.width, height: entry.height });
    }
    return atlasTexture;
}, _WebGpuRendererImpl_createSpriteAtlasBindGroup = function _WebGpuRendererImpl_createSpriteAtlasBindGroup(atlasTexture) {
    const atlasView = atlasTexture.createView();
    const textureBindGroupLayout = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteTextureBindGroupLayout, "f");
    const sampler = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteSampler, "f");
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
}, _WebGpuRendererImpl_ensureSpritePipeline = function _WebGpuRendererImpl_ensureSpritePipeline() {
    if (__classPrivateFieldGet(this, _WebGpuRendererImpl_spritePipeline, "f") && __classPrivateFieldGet(this, _WebGpuRendererImpl_rectPipeline, "f")) {
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
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteTextureBindGroupLayout, this.device.createBindGroupLayout({
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
    }), "f");
    const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [uniformBindGroupLayout, __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteTextureBindGroupLayout, "f")],
    });
    const shaderModule = this.device.createShaderModule({ code: SPRITE_SHADER });
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spritePipeline, this.device.createRenderPipeline({
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
    }), "f");
    const rectPipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [uniformBindGroupLayout],
    });
    const rectShaderModule = this.device.createShaderModule({ code: RECT_SHADER });
    __classPrivateFieldSet(this, _WebGpuRendererImpl_rectPipeline, this.device.createRenderPipeline({
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
    }), "f");
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteSampler, this.device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
    }), "f");
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteUniformBuffer, this.device.createBuffer({
        size: GLOBALS_BUFFER_SIZE,
        usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    }), "f");
    __classPrivateFieldSet(this, _WebGpuRendererImpl_worldGlobalsBindGroup, this.device.createBindGroup({
        layout: uniformBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteUniformBuffer, "f"),
                    offset: WORLD_GLOBALS_OFFSET,
                    size: GLOBALS_UNIFORM_BYTES,
                },
            },
        ],
    }), "f");
    __classPrivateFieldSet(this, _WebGpuRendererImpl_uiGlobalsBindGroup, this.device.createBindGroup({
        layout: uniformBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteUniformBuffer, "f"),
                    offset: UI_GLOBALS_OFFSET,
                    size: GLOBALS_UNIFORM_BYTES,
                },
            },
        ],
    }), "f");
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteVertexBuffer, this.device.createBuffer({
        size: QUAD_VERTEX_DATA.byteLength,
        usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
    }), "f");
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteIndexBuffer, this.device.createBuffer({
        size: QUAD_INDEX_DATA.byteLength,
        usage: GPU_BUFFER_USAGE.INDEX | GPU_BUFFER_USAGE.COPY_DST,
    }), "f");
    this.device.queue.writeBuffer(__classPrivateFieldGet(this, _WebGpuRendererImpl_spriteVertexBuffer, "f"), 0, toArrayBuffer(QUAD_VERTEX_DATA));
    this.device.queue.writeBuffer(__classPrivateFieldGet(this, _WebGpuRendererImpl_spriteIndexBuffer, "f"), 0, toArrayBuffer(QUAD_INDEX_DATA));
}, _WebGpuRendererImpl_ensureInstanceBuffer = function _WebGpuRendererImpl_ensureInstanceBuffer(requiredBytes) {
    if (__classPrivateFieldGet(this, _WebGpuRendererImpl_spriteInstanceBuffer, "f") && __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteInstanceBufferSize, "f") >= requiredBytes) {
        return;
    }
    const size = Math.max(1024, __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteInstanceBufferSize, "f") * 2, requiredBytes);
    const previousBuffer = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteInstanceBuffer, "f");
    const nextBuffer = this.device.createBuffer({
        size,
        usage: GPU_BUFFER_USAGE.VERTEX | GPU_BUFFER_USAGE.COPY_DST,
    });
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteInstanceBuffer, nextBuffer, "f");
    __classPrivateFieldSet(this, _WebGpuRendererImpl_spriteInstanceBufferSize, size, "f");
    if (previousBuffer) {
        __classPrivateFieldGet(this, _WebGpuRendererImpl_retiredInstanceBuffers, "f").push(previousBuffer);
    }
}, _WebGpuRendererImpl_writeGlobals = function _WebGpuRendererImpl_writeGlobals(offset, camera) {
    const buffer = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteUniformBuffer, "f");
    if (!buffer) {
        throw new Error('Sprite pipeline missing globals buffer.');
    }
    const data = new Float32Array([
        this.canvas.width,
        this.canvas.height,
        __classPrivateFieldGet(this, _WebGpuRendererImpl_devicePixelRatio, "f"),
        0,
        camera.x,
        camera.y,
        camera.zoom,
        0,
    ]);
    this.device.queue.writeBuffer(buffer, offset, toArrayBuffer(data));
}, _WebGpuRendererImpl_toDeviceScissorRect = function _WebGpuRendererImpl_toDeviceScissorRect(options) {
    const viewportWidth = this.canvas.width;
    const viewportHeight = this.canvas.height;
    const width = Number.isFinite(options.width) ? Math.max(0, options.width) : 0;
    const height = Number.isFinite(options.height) ? Math.max(0, options.height) : 0;
    const x0Input = Number.isFinite(options.x) ? options.x : 0;
    const y0Input = Number.isFinite(options.y) ? options.y : 0;
    const x1Input = x0Input + width;
    const y1Input = y0Input + height;
    const devicePixelRatio = __classPrivateFieldGet(this, _WebGpuRendererImpl_devicePixelRatio, "f");
    let deviceX0 = 0;
    let deviceY0 = 0;
    let deviceX1 = 0;
    let deviceY1 = 0;
    if (options.passId === 'ui') {
        deviceX0 = x0Input * devicePixelRatio;
        deviceY0 = y0Input * devicePixelRatio;
        deviceX1 = x1Input * devicePixelRatio;
        deviceY1 = y1Input * devicePixelRatio;
    }
    else {
        const camera = __classPrivateFieldGet(this, _WebGpuRendererImpl_worldCamera, "f");
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
}, _WebGpuRendererImpl_getQuadPipelinesOrThrow = function _WebGpuRendererImpl_getQuadPipelinesOrThrow() {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_ensureSpritePipeline).call(this);
    const spritePipeline = __classPrivateFieldGet(this, _WebGpuRendererImpl_spritePipeline, "f");
    const rectPipeline = __classPrivateFieldGet(this, _WebGpuRendererImpl_rectPipeline, "f");
    const vertexBuffer = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteVertexBuffer, "f");
    const indexBuffer = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteIndexBuffer, "f");
    const worldGlobalsBindGroup = __classPrivateFieldGet(this, _WebGpuRendererImpl_worldGlobalsBindGroup, "f");
    const uiGlobalsBindGroup = __classPrivateFieldGet(this, _WebGpuRendererImpl_uiGlobalsBindGroup, "f");
    if (!spritePipeline ||
        !rectPipeline ||
        !vertexBuffer ||
        !indexBuffer ||
        !worldGlobalsBindGroup ||
        !uiGlobalsBindGroup) {
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
}, _WebGpuRendererImpl_createQuadRenderState = function _WebGpuRendererImpl_createQuadRenderState(passEncoder, orderedDraws) {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_quadInstanceWriter, "f").reset();
    const hasQuadDraws = orderedDraws.some((entry) => entry.draw.kind === 'rect' ||
        entry.draw.kind === 'image' ||
        entry.draw.kind === 'text');
    if (!hasQuadDraws) {
        return undefined;
    }
    const atlasUvByAssetId = __classPrivateFieldGet(this, _WebGpuRendererImpl_atlasUvByAssetId, "f");
    const textureBindGroup = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteTextureBindGroup, "f");
    const bitmapFontByAssetId = __classPrivateFieldGet(this, _WebGpuRendererImpl_bitmapFontByAssetId, "f");
    const defaultBitmapFontAssetId = __classPrivateFieldGet(this, _WebGpuRendererImpl_defaultBitmapFontAssetId, "f");
    const requiresSpriteAtlas = orderedDraws.some((entry) => entry.draw.kind === 'image' || entry.draw.kind === 'text');
    if (requiresSpriteAtlas && (!atlasUvByAssetId || !textureBindGroup)) {
        throw new Error('No sprite atlas loaded. Call renderer.loadAssets(...) before rendering image/text draws.');
    }
    const hasTextDraws = orderedDraws.some((entry) => entry.draw.kind === 'text');
    if (hasTextDraws && (!bitmapFontByAssetId || bitmapFontByAssetId.size === 0)) {
        throw new Error('No bitmap fonts loaded. Include font assets in the manifest and implement assets.loadFont(...).');
    }
    const pipelines = __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_getQuadPipelinesOrThrow).call(this);
    const viewportScissor = {
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
        batchInstances: __classPrivateFieldGet(this, _WebGpuRendererImpl_quadInstanceWriter, "f"),
    };
}, _WebGpuRendererImpl_applyScissorRect = function _WebGpuRendererImpl_applyScissorRect(state, rect) {
    if (state.appliedScissor && isSameScissorRect(state.appliedScissor, rect)) {
        return;
    }
    state.passEncoder.setScissorRect(rect.x, rect.y, rect.width, rect.height);
    state.appliedScissor = rect;
}, _WebGpuRendererImpl_resetQuadBatch = function _WebGpuRendererImpl_resetQuadBatch(state) {
    state.batchKind = undefined;
    state.batchPassId = undefined;
    state.batchInstances.reset();
}, _WebGpuRendererImpl_flushQuadBatch = function _WebGpuRendererImpl_flushQuadBatch(state) {
    const kind = state.batchKind;
    const passId = state.batchPassId;
    const instanceCount = state.batchInstances.instanceCount;
    const usedBytes = state.batchInstances.usedByteLength;
    if (!kind || !passId || instanceCount <= 0 || usedBytes <= 0) {
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_resetQuadBatch).call(this, state);
        return;
    }
    if (state.currentScissor.width <= 0 || state.currentScissor.height <= 0) {
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_resetQuadBatch).call(this, state);
        return;
    }
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_ensureInstanceBuffer).call(this, usedBytes);
    const instanceBuffer = __classPrivateFieldGet(this, _WebGpuRendererImpl_spriteInstanceBuffer, "f");
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
    }
    else {
        state.passEncoder.setPipeline(state.rectPipeline);
    }
    state.passEncoder.setBindGroup(0, globals);
    state.passEncoder.setVertexBuffer(0, state.vertexBuffer);
    state.passEncoder.setVertexBuffer(1, instanceBuffer);
    state.passEncoder.setIndexBuffer(state.indexBuffer, 'uint16');
    state.passEncoder.drawIndexed(6, instanceCount, 0, 0, 0);
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_resetQuadBatch).call(this, state);
}, _WebGpuRendererImpl_ensureQuadBatch = function _WebGpuRendererImpl_ensureQuadBatch(state, kind, passId) {
    if (state.batchKind === kind && state.batchPassId === passId) {
        return;
    }
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushQuadBatch).call(this, state);
    state.batchKind = kind;
    state.batchPassId = passId;
}, _WebGpuRendererImpl_setQuadPass = function _WebGpuRendererImpl_setQuadPass(state, passId) {
    if (state.currentPassId === passId) {
        return;
    }
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushQuadBatch).call(this, state);
    state.currentPassId = passId;
    state.scissorStack = [];
    state.currentScissor = state.viewportScissor;
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_applyScissorRect).call(this, state, state.currentScissor);
}, _WebGpuRendererImpl_spriteUvOrThrow = function _WebGpuRendererImpl_spriteUvOrThrow(state, assetId) {
    const atlasUvByAssetId = state.atlasUvByAssetId;
    if (!atlasUvByAssetId) {
        throw new Error('Sprite atlas missing UVs.');
    }
    const uv = atlasUvByAssetId.get(assetId);
    if (!uv) {
        throw new Error(`Atlas missing UVs for AssetId: ${assetId}`);
    }
    return uv;
}, _WebGpuRendererImpl_renderQuadDrawEntry = function _WebGpuRendererImpl_renderQuadDrawEntry(state, entry) {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_setQuadPass).call(this, state, entry.passId);
    const draw = entry.draw;
    switch (draw.kind) {
        case 'scissorPush':
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_handleScissorPushDraw).call(this, state, entry.passId, draw);
            break;
        case 'scissorPop':
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_handleScissorPopDraw).call(this, state);
            break;
        case 'rect':
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_handleRectDraw).call(this, state, entry.passId, draw);
            break;
        case 'image':
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_handleImageDraw).call(this, state, entry.passId, draw);
            break;
        case 'text':
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_handleTextDraw).call(this, state, entry.passId, draw);
            break;
        default:
            __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushQuadBatch).call(this, state);
            break;
    }
}, _WebGpuRendererImpl_handleScissorPushDraw = function _WebGpuRendererImpl_handleScissorPushDraw(state, passId, draw) {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushQuadBatch).call(this, state);
    const coordScale = passId === 'world' ? __classPrivateFieldGet(this, _WebGpuRendererImpl_worldFixedPointInvScale, "f") : 1;
    const scissor = __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_toDeviceScissorRect).call(this, {
        passId,
        x: draw.x * coordScale,
        y: draw.y * coordScale,
        width: draw.width * coordScale,
        height: draw.height * coordScale,
    });
    state.scissorStack.push(state.currentScissor);
    state.currentScissor = intersectScissorRect(state.currentScissor, scissor);
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_applyScissorRect).call(this, state, state.currentScissor);
}, _WebGpuRendererImpl_handleScissorPopDraw = function _WebGpuRendererImpl_handleScissorPopDraw(state) {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushQuadBatch).call(this, state);
    state.currentScissor = state.scissorStack.pop() ?? state.viewportScissor;
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_applyScissorRect).call(this, state, state.currentScissor);
}, _WebGpuRendererImpl_handleRectDraw = function _WebGpuRendererImpl_handleRectDraw(state, passId, draw) {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_ensureQuadBatch).call(this, state, 'rect', passId);
    const coordScale = passId === 'world' ? __classPrivateFieldGet(this, _WebGpuRendererImpl_worldFixedPointInvScale, "f") : 1;
    state.batchInstances.writeInstanceRgba(draw.x * coordScale, draw.y * coordScale, draw.width * coordScale, draw.height * coordScale, ZERO_SPRITE_UV_RECT, draw.colorRgba);
}, _WebGpuRendererImpl_handleImageDraw = function _WebGpuRendererImpl_handleImageDraw(state, passId, draw) {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_ensureQuadBatch).call(this, state, 'image', passId);
    const coordScale = passId === 'world' ? __classPrivateFieldGet(this, _WebGpuRendererImpl_worldFixedPointInvScale, "f") : 1;
    const uv = __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_spriteUvOrThrow).call(this, state, draw.assetId);
    state.batchInstances.writeInstanceRgba(draw.x * coordScale, draw.y * coordScale, draw.width * coordScale, draw.height * coordScale, uv, draw.tintRgba);
}, _WebGpuRendererImpl_handleTextDraw = function _WebGpuRendererImpl_handleTextDraw(state, passId, draw) {
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_ensureQuadBatch).call(this, state, 'image', passId);
    const coordScale = passId === 'world' ? __classPrivateFieldGet(this, _WebGpuRendererImpl_worldFixedPointInvScale, "f") : 1;
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
}, _WebGpuRendererImpl_renderDraws = function _WebGpuRendererImpl_renderDraws(passEncoder, orderedDraws) {
    const state = __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_createQuadRenderState).call(this, passEncoder, orderedDraws);
    if (!state) {
        return;
    }
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_writeGlobals).call(this, WORLD_GLOBALS_OFFSET, __classPrivateFieldGet(this, _WebGpuRendererImpl_worldCamera, "f"));
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_writeGlobals).call(this, UI_GLOBALS_OFFSET, { x: 0, y: 0, zoom: 1 });
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_applyScissorRect).call(this, state, state.viewportScissor);
    for (const entry of orderedDraws) {
        __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_renderQuadDrawEntry).call(this, state, entry);
    }
    __classPrivateFieldGet(this, _WebGpuRendererImpl_instances, "m", _WebGpuRendererImpl_flushQuadBatch).call(this, state);
};
function getNavigatorGpu() {
    const maybeNavigator = globalThis.navigator;
    if (!maybeNavigator?.gpu) {
        throw new WebGpuNotSupportedError('WebGPU is not available in this environment.');
    }
    return maybeNavigator.gpu;
}
function getDefaultCanvasFormat(gpu, context, adapter) {
    if ('getPreferredCanvasFormat' in gpu && typeof gpu.getPreferredCanvasFormat === 'function') {
        return gpu.getPreferredCanvasFormat();
    }
    const legacyContext = context;
    if (typeof legacyContext.getPreferredFormat === 'function') {
        return legacyContext.getPreferredFormat(adapter);
    }
    return 'bgra8unorm';
}
function pickPreferredFormat(options) {
    if (options.preferredFormats?.length) {
        return options.preferredFormats[0];
    }
    return getDefaultCanvasFormat(options.gpu, options.context, options.adapter);
}
export async function createWebGpuRenderer(canvas, options) {
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
//# sourceMappingURL=webgpu-renderer.js.map