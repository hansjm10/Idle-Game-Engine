export type RuntimeBacklogFields = Readonly<{
  readonly accumulatorBacklogMs?: number;
  readonly hostFrameBacklogMs?: number;
  readonly creditedBacklogMs?: number;
}>;

export type NormalizedRuntimeBacklogFields = Readonly<{
  readonly accumulatorBacklogMs: number;
  readonly hostFrameBacklogMs: number;
  readonly creditedBacklogMs: number;
}>;

export function normalizeRuntimeBacklogFields(
  fields: RuntimeBacklogFields | undefined,
): NormalizedRuntimeBacklogFields {
  const creditedBacklogMs = fields?.creditedBacklogMs ?? 0;
  const hostFrameBacklogMs =
    fields?.hostFrameBacklogMs ??
    Math.max(0, (fields?.accumulatorBacklogMs ?? 0) - creditedBacklogMs);

  return {
    accumulatorBacklogMs: hostFrameBacklogMs + creditedBacklogMs,
    hostFrameBacklogMs,
    creditedBacklogMs,
  };
}
