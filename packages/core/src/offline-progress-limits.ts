export type OfflineProgressLimits = Readonly<{
  readonly maxElapsedMs?: number;
  readonly maxSteps?: number;
  readonly maxTicksPerCall?: number;
}>;

export type OfflineProgressTotals = Readonly<{
  readonly totalMs: number;
  readonly totalSteps: number;
  readonly totalRemainderMs: number;
}>;

function normalizeNonNegativeNumber(
  value: number | undefined,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function resolveOfflineProgressTotals(
  elapsedMs: number,
  stepSizeMs: number,
  limits?: OfflineProgressLimits,
): OfflineProgressTotals {
  const normalizedElapsed = normalizeNonNegativeNumber(elapsedMs) ?? 0;
  let cappedElapsedMs = normalizedElapsed;

  const maxElapsedMs = normalizeNonNegativeNumber(limits?.maxElapsedMs);
  if (maxElapsedMs !== undefined) {
    cappedElapsedMs = Math.min(cappedElapsedMs, maxElapsedMs);
  }

  const fullSteps =
    stepSizeMs > 0 ? Math.floor(cappedElapsedMs / stepSizeMs) : 0;
  const remainderMs = stepSizeMs > 0
    ? cappedElapsedMs - fullSteps * stepSizeMs
    : 0;

  const maxSteps = normalizeNonNegativeInteger(limits?.maxSteps);
  const totalSteps = maxSteps !== undefined
    ? Math.min(fullSteps, maxSteps)
    : fullSteps;
  const totalRemainderMs = totalSteps === fullSteps ? remainderMs : 0;
  const totalMs = totalSteps * stepSizeMs + totalRemainderMs;

  return { totalMs, totalSteps, totalRemainderMs };
}

export function resolveMaxTicksPerCall(
  limits?: OfflineProgressLimits,
): number | undefined {
  const maxTicksPerCall = normalizeNonNegativeInteger(limits?.maxTicksPerCall);
  if (maxTicksPerCall === undefined || maxTicksPerCall <= 0) {
    return undefined;
  }
  return maxTicksPerCall;
}
