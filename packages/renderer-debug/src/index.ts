/**
 * Canvas2D renderer + helpers for inspecting `RenderCommandBuffer` output.
 *
 * Typical usage:
 * - Size the canvas in device pixels: `canvas.width = cssWidth * devicePixelRatio`.
 * - Pass `pixelRatio: devicePixelRatio` to `renderRenderCommandBufferToCanvas2d`.
 * - Provide `assets.resolveImage` / `assets.resolveFontFamily` to render images/text.
 * - Use `createRenderCommandBufferStepper` to scrub recorded frames without rerunning the sim.
 */
export { renderRenderCommandBufferToCanvas2d } from './canvas2d-renderer.js';
export { rgbaToCssColor } from './color.js';
export { createRenderCommandBufferStepper } from './rcb-stepper.js';
export { validateRenderCommandBuffer } from './rcb-validation.js';

export type {
  Canvas2dContextLike,
  CanvasFillStyle,
  RenderCommandBufferToCanvas2dOptions,
  RendererDebugAssets,
} from './canvas2d-renderer.js';

export type {
  RenderCommandBufferStepper,
} from './rcb-stepper.js';

export type {
  RenderCommandBufferValidationResult,
} from './rcb-validation.js';
