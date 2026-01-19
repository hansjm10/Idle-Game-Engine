import type { AssetId, RenderCommandBuffer } from '@idle-engine/renderer-contract';
export type CanvasFillStyle = string | CanvasGradient | CanvasPattern;
export interface Canvas2dContextLike {
    readonly canvas: {
        readonly width: number;
        readonly height: number;
    };
    fillStyle: CanvasFillStyle;
    strokeStyle: CanvasFillStyle;
    globalAlpha: number;
    lineWidth: number;
    font: string;
    textBaseline: CanvasTextBaseline;
    textAlign: CanvasTextAlign;
    save(): void;
    restore(): void;
    beginPath(): void;
    rect(x: number, y: number, width: number, height: number): void;
    clip(): void;
    clearRect(x: number, y: number, width: number, height: number): void;
    fillRect(x: number, y: number, width: number, height: number): void;
    strokeRect(x: number, y: number, width: number, height: number): void;
    fillText(text: string, x: number, y: number): void;
    drawImage(image: CanvasImageSource, dx: number, dy: number, dWidth: number, dHeight: number): void;
}
export interface RendererDebugAssets {
    resolveImage?(assetId: AssetId): CanvasImageSource | undefined;
    resolveFontFamily?(assetId: AssetId): string | undefined;
}
export interface RenderCommandBufferToCanvas2dOptions {
    /**
     * Scales draw coordinates and font size.
     *
     * The canvas is expected to already be sized in device pixels
     * (`ctx.canvas.width/height`). `clear` fills the raw canvas dimensions,
     * while other draws multiply coordinates by `pixelRatio`.
     */
    readonly pixelRatio?: number;
    readonly assets?: RendererDebugAssets;
    readonly validate?: boolean;
}
export declare function renderRenderCommandBufferToCanvas2d(ctx: Canvas2dContextLike, rcb: RenderCommandBuffer, options?: RenderCommandBufferToCanvas2dOptions): void;
//# sourceMappingURL=canvas2d-renderer.d.ts.map