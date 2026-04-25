export type RenderFrameMetadata = Readonly<{
  step: number;
  simTimeMs: number;
}>;

/**
 * Renderer frames use the completed deterministic runtime step as their
 * canonical frame step. During a system tick, TickContext.step is already that
 * completed step, and simTimeMs is the step offset from simulation start.
 */
export function buildRenderFrameMetadata(
  processedStep: number,
  stepSizeMs: number,
): RenderFrameMetadata {
  return {
    step: processedStep,
    simTimeMs: processedStep * stepSizeMs,
  };
}

/**
 * Runtime nextStep points at the next unprocessed step. A current/paused frame
 * therefore represents the last completed step, clamped to step 0 before the
 * simulation has processed any steps.
 */
export function buildLastCompletedRenderFrameMetadata(
  nextStep: number,
  stepSizeMs: number,
): RenderFrameMetadata {
  return buildRenderFrameMetadata(Math.max(0, nextStep - 1), stepSizeMs);
}
