import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

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

  resize(options?: WebGpuRendererResizeOptions): void;
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
  const clearDraw =
    clearDrawByPass ?? rcb.draws.find((draw) => draw.kind === 'clear');
  if (!clearDraw) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  return colorRgbaToGpuColor(clearDraw.colorRgba);
}

function getCanvasPixelSize(
  canvas: HTMLCanvasElement,
  devicePixelRatio: number,
): { width: number; height: number } {
  const targetWidth = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const targetHeight = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
  return { width: targetWidth, height: targetHeight };
}

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

    void this.device.lost.then((info) => {
      if (this.#disposed) {
        return;
      }
      this.#lost = true;
      this.#onDeviceLost?.(
        new WebGpuDeviceLostError(
          `WebGPU device lost${info.message ? `: ${info.message}` : ''}`,
          info.reason,
        ),
      );
    });
  }

  resize(options?: WebGpuRendererResizeOptions): void {
    if (this.#disposed || this.#lost) {
      return;
    }

    const devicePixelRatio =
      options?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    const { width, height } = getCanvasPixelSize(this.canvas, devicePixelRatio);

    if (this.canvas.width === width && this.canvas.height === height) {
      return;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: this.#alphaMode,
    });
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
  context.configure({ device, format, alphaMode });

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
};
