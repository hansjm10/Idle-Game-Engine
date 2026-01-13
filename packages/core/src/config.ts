export interface EngineConfig {
  readonly precision: {
    /**
     * Absolute tolerance floor used when comparing resource floats for "dirty"
     * detection (publishing + persistence).
     *
     * @defaultValue `1e-9`
     */
    readonly dirtyEpsilonAbsolute: number;
    /**
     * Relative tolerance multiplier used when comparing resource floats for
     * "dirty" detection (scaled by the compared value magnitude).
     *
     * @defaultValue `1e-9`
     */
    readonly dirtyEpsilonRelative: number;
    /**
     * Maximum tolerance used for relative comparisons when a resource does not
     * provide a per-resource `dirtyTolerance` override.
     *
     * @defaultValue `1e-3`
     */
    readonly dirtyEpsilonCeiling: number;
    /**
     * Clamp applied to per-resource `dirtyTolerance` overrides to prevent
     * extremely large tolerances from hiding meaningful changes.
     *
     * @defaultValue `0.5`
     */
    readonly dirtyEpsilonOverrideMax: number;
  };
  readonly limits: {
    /**
     * Default maximum transform runs per tick when not authored on a transform.
     *
     * @defaultValue `10`
     */
    readonly maxRunsPerTick: number;
    /**
     * Hard cap for transform `maxRunsPerTick` (authored or default) to prevent
     * runaway loops.
     *
     * @defaultValue `100`
     */
    readonly maxRunsPerTickHardCap: number;
    /**
     * Default maximum outstanding batches per transform when not authored.
     *
     * @defaultValue `50`
     */
    readonly maxOutstandingBatches: number;
    /**
     * Hard cap for transform `maxOutstandingBatches` (authored or default) to
     * prevent unbounded queue growth.
     *
     * @defaultValue `1000`
     */
    readonly maxOutstandingBatchesHardCap: number;
    /**
     * Maximum number of queued commands retained by the runtime command queue.
     *
     * @defaultValue `10000`
     */
    readonly maxCommandQueueSize: number;
    /**
     * Maximum recursion depth allowed during condition evaluation to guard
     * against circular dependencies.
     *
     * @defaultValue `100`
     */
    readonly maxConditionDepth: number;
    /**
     * Default EventBus channel capacity when not specified per-channel.
     *
     * @defaultValue `256`
     */
    readonly eventBusDefaultChannelCapacity: number;
  };
}

export type EngineConfigOverrides = Readonly<{
  readonly precision?: Partial<EngineConfig['precision']>;
  readonly limits?: Partial<EngineConfig['limits']>;
}>;

export const DEFAULT_ENGINE_CONFIG: EngineConfig = Object.freeze({
  precision: Object.freeze({
    dirtyEpsilonAbsolute: 1e-9,
    dirtyEpsilonRelative: 1e-9,
    dirtyEpsilonCeiling: 1e-3,
    dirtyEpsilonOverrideMax: 5e-1,
  }),
  limits: Object.freeze({
    maxRunsPerTick: 10,
    maxRunsPerTickHardCap: 100,
    maxOutstandingBatches: 50,
    maxOutstandingBatchesHardCap: 1000,
    maxCommandQueueSize: 10_000,
    maxConditionDepth: 100,
    eventBusDefaultChannelCapacity: 256,
  }),
});

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(numeric));
}

function resolvePrecisionConfig(
  overrides: EngineConfigOverrides['precision'] | undefined,
): EngineConfig['precision'] {
  const source = overrides ?? {};
  const defaults = DEFAULT_ENGINE_CONFIG.precision;

  return {
    dirtyEpsilonAbsolute:
      toFiniteNumber(source.dirtyEpsilonAbsolute) ?? defaults.dirtyEpsilonAbsolute,
    dirtyEpsilonRelative:
      toFiniteNumber(source.dirtyEpsilonRelative) ?? defaults.dirtyEpsilonRelative,
    dirtyEpsilonCeiling:
      toFiniteNumber(source.dirtyEpsilonCeiling) ?? defaults.dirtyEpsilonCeiling,
    dirtyEpsilonOverrideMax:
      toFiniteNumber(source.dirtyEpsilonOverrideMax) ?? defaults.dirtyEpsilonOverrideMax,
  };
}

function resolveLimitsConfig(
  overrides: EngineConfigOverrides['limits'] | undefined,
): EngineConfig['limits'] {
  const source = overrides ?? {};
  const defaults = DEFAULT_ENGINE_CONFIG.limits;

  const maxRunsPerTickHardCap =
    toPositiveInt(source.maxRunsPerTickHardCap) ?? defaults.maxRunsPerTickHardCap;
  const maxRunsPerTick =
    toPositiveInt(source.maxRunsPerTick) ?? defaults.maxRunsPerTick;

  const maxOutstandingBatchesHardCap =
    toPositiveInt(source.maxOutstandingBatchesHardCap) ??
    defaults.maxOutstandingBatchesHardCap;
  const maxOutstandingBatches =
    toPositiveInt(source.maxOutstandingBatches) ?? defaults.maxOutstandingBatches;

  return {
    maxRunsPerTick: Math.min(maxRunsPerTick, maxRunsPerTickHardCap),
    maxRunsPerTickHardCap,
    maxOutstandingBatches: Math.min(maxOutstandingBatches, maxOutstandingBatchesHardCap),
    maxOutstandingBatchesHardCap,
    maxCommandQueueSize:
      toPositiveInt(source.maxCommandQueueSize) ?? defaults.maxCommandQueueSize,
    maxConditionDepth:
      toPositiveInt(source.maxConditionDepth) ?? defaults.maxConditionDepth,
    eventBusDefaultChannelCapacity:
      toPositiveInt(source.eventBusDefaultChannelCapacity) ??
      defaults.eventBusDefaultChannelCapacity,
  };
}

export function resolveEngineConfig(
  overrides?: EngineConfigOverrides,
): EngineConfig {
  const config: EngineConfig = {
    precision: resolvePrecisionConfig(overrides?.precision),
    limits: resolveLimitsConfig(overrides?.limits),
  };
  return Object.freeze({
    precision: Object.freeze(config.precision),
    limits: Object.freeze(config.limits),
  });
}
