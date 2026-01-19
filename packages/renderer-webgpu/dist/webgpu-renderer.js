var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _WebGpuRendererImpl_alphaMode, _WebGpuRendererImpl_onDeviceLost, _WebGpuRendererImpl_disposed, _WebGpuRendererImpl_lost;
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
    if (!clearDrawCandidate || clearDrawCandidate.kind !== 'clear') {
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
class WebGpuRendererImpl {
    constructor(options) {
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
        _WebGpuRendererImpl_disposed.set(this, false);
        _WebGpuRendererImpl_lost.set(this, false);
        this.canvas = options.canvas;
        this.context = options.context;
        this.adapter = options.adapter;
        this.device = options.device;
        this.format = options.format;
        __classPrivateFieldSet(this, _WebGpuRendererImpl_alphaMode, options.alphaMode, "f");
        __classPrivateFieldSet(this, _WebGpuRendererImpl_onDeviceLost, options.onDeviceLost, "f");
        void this.device.lost.then((info) => {
            if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f")) {
                return;
            }
            __classPrivateFieldSet(this, _WebGpuRendererImpl_lost, true, "f");
            __classPrivateFieldGet(this, _WebGpuRendererImpl_onDeviceLost, "f")?.call(this, new WebGpuDeviceLostError(`WebGPU device lost${info.message ? `: ${info.message}` : ''}`, info.reason));
        });
    }
    resize(options) {
        if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f") || __classPrivateFieldGet(this, _WebGpuRendererImpl_lost, "f")) {
            return;
        }
        const devicePixelRatio = options?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
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
    render(rcb) {
        if (__classPrivateFieldGet(this, _WebGpuRendererImpl_disposed, "f") || __classPrivateFieldGet(this, _WebGpuRendererImpl_lost, "f")) {
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
    dispose() {
        __classPrivateFieldSet(this, _WebGpuRendererImpl_disposed, true, "f");
    }
}
_WebGpuRendererImpl_alphaMode = new WeakMap(), _WebGpuRendererImpl_onDeviceLost = new WeakMap(), _WebGpuRendererImpl_disposed = new WeakMap(), _WebGpuRendererImpl_lost = new WeakMap();
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
//# sourceMappingURL=webgpu-renderer.js.map