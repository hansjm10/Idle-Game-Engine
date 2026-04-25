export type RuntimeBacklogFields = Readonly<{
  readonly accumulatorBacklogMs?: unknown;
  readonly hostFrameBacklogMs?: unknown;
  readonly creditedBacklogMs?: unknown;
}>;

export type NormalizedRuntimeBacklogFields = Readonly<{
  readonly accumulatorBacklogMs: number;
  readonly hostFrameBacklogMs: number;
  readonly creditedBacklogMs: number;
}>;

export type NormalizedRuntimeBacklogSourceState = Readonly<{
  readonly hostFrameMs: number;
  readonly creditedMs: number;
}>;

function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function normalizeRuntimeBacklogFields(
  fields: RuntimeBacklogFields | undefined,
): NormalizedRuntimeBacklogFields {
  const accumulatorBacklogMs = readNonNegativeNumber(
    fields?.accumulatorBacklogMs,
  );
  const creditedBacklogMs =
    readNonNegativeNumber(fields?.creditedBacklogMs) ?? 0;
  const hostFrameBacklogMs =
    readNonNegativeNumber(fields?.hostFrameBacklogMs) ??
    Math.max(0, (accumulatorBacklogMs ?? 0) - creditedBacklogMs);

  return {
    accumulatorBacklogMs: hostFrameBacklogMs + creditedBacklogMs,
    hostFrameBacklogMs,
    creditedBacklogMs,
  };
}

export function normalizeRuntimeBacklogSourceState(
  fields: RuntimeBacklogFields | undefined,
): NormalizedRuntimeBacklogSourceState {
  const backlog = normalizeRuntimeBacklogFields(fields);

  return {
    hostFrameMs: backlog.hostFrameBacklogMs,
    creditedMs: backlog.creditedBacklogMs,
  };
}
