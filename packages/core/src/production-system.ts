import type { System } from './index.js';

/**
 * Minimal interface for resource state operations needed by the production system.
 * This abstraction allows for easier testing and reduces tight coupling to the
 * full ResourceState implementation.
 */
export interface ProductionResourceState {
  /** Get the internal index for a resource ID. Returns undefined if not found. */
  getIndex(resourceId: string): number | undefined;
  /** Get the current amount of a resource by index. */
  getAmount(index: number): number;
  /** Add an amount to a resource by index. */
  addAmount(index: number, amount: number): void;
  /** Spend an amount from a resource by index. Returns true if successful. */
  spendAmount(
    index: number,
    amount: number,
    context?: { systemId?: string },
  ): boolean;
}

interface ProductionResourceStateRateTracker {
  applyIncome(index: number, amountPerSecond: number): void;
  applyExpense(index: number, amountPerSecond: number): void;
}

type ProductionResourceStateWithRateTracking =
  ProductionResourceState & ProductionResourceStateRateTracker;

function supportsRateTracking(
  resourceState: ProductionResourceState,
): resourceState is ProductionResourceStateWithRateTracking {
  return (
    typeof (resourceState as ProductionResourceStateWithRateTracking).applyIncome === 'function' &&
    typeof (resourceState as ProductionResourceStateWithRateTracking).applyExpense === 'function'
  );
}

interface ProductionResourceStateFinalizer {
  finalizeTick(deltaMs: number): void;
}

type ProductionResourceStateWithFinalizeTick =
  ProductionResourceState & ProductionResourceStateFinalizer;

function supportsFinalizeTick(
  resourceState: ProductionResourceState,
): resourceState is ProductionResourceStateWithFinalizeTick {
  return (
    typeof (resourceState as ProductionResourceStateWithFinalizeTick).finalizeTick === 'function'
  );
}

interface ProductionResourceStateCapacityAccessor {
  getCapacity(index: number): number;
}

type ProductionResourceStateWithCapacity =
  ProductionResourceState & ProductionResourceStateCapacityAccessor;

function supportsCapacity(
  resourceState: ProductionResourceState,
): resourceState is ProductionResourceStateWithCapacity {
  return (
    typeof (resourceState as ProductionResourceStateWithCapacity).getCapacity === 'function'
  );
}

interface ProductionResourceStatePerTickReset {
  snapshot(options?: { mode?: 'publish' | 'recorder' }): unknown;
  resetPerTickAccumulators(): void;
}

function supportsPerTickReset(
  resourceState: ProductionResourceState,
): resourceState is ProductionResourceState & ProductionResourceStatePerTickReset {
  const candidate = resourceState as ProductionResourceState &
    Partial<ProductionResourceStatePerTickReset>;
  return (
    typeof candidate.snapshot === 'function' &&
    typeof candidate.resetPerTickAccumulators === 'function'
  );
}

/**
 * Serialized accumulator state for save/load persistence.
 *
 * Key formats:
 * - v2 (collision-free): `v2|${encodeURIComponent(generatorId)}|${operation}|${encodeURIComponent(resourceId)}`
 * - legacy (backwards compatible): `${generatorId}:${operation}:${resourceId}`
 *
 * The legacy format is not collision-free if generator/resource IDs contain `:` (for example,
 * `foo:produce:produce:bar` can be produced by multiple (generatorId, resourceId) pairs).
 */
export interface SerializedProductionAccumulators {
  /** Map of accumulator keys to their current fractional values */
  readonly accumulators: Record<string, number>;
}

/**
 * Represents a production or consumption rate for a specific resource.
 */
export interface GeneratorProductionRate {
  /** The ID of the resource being produced or consumed */
  readonly resourceId: string;
  /**
   * The rate per second at which the resource is produced/consumed per owned generator.
   * Must be a positive finite number. Invalid values (negative, zero, NaN, Infinity)
   * are silently ignored during production calculations.
   */
  readonly rate: number;
}

/**
 * Represents the production state of a generator.
 */
export interface GeneratorProductionState {
  /** Unique identifier for the generator */
  readonly id: string;
  /** Number of generators owned (acts as a multiplier) */
  readonly owned: number;
  /** Whether the generator is enabled (defaults to true when omitted). */
  readonly enabled?: boolean;
  /** Resources produced by this generator per tick */
  readonly produces: readonly GeneratorProductionRate[];
  /**
   * Resources consumed by this generator per tick.
   *
   * When a generator has consumption requirements, production is automatically
   * scaled based on available input resources. The system calculates a consumption
   * ratio (0-1) as the minimum of all ratios: available / required for each consumed
   * resource. Both production and consumption are then scaled by this ratio.
   *
   * @example
   * // Generator needs 5 energy/s but only 2.5 available
   * // consumptionRatio = 2.5 / 5 = 0.5 (50%)
   * // All production and consumption scaled to 50%
   * consumes: [{ resourceId: 'energy', rate: 5 }]
   *
   * @example
   * // Multiple requirements - uses minimum ratio
   * // If energy: 8/10 = 0.8, fuel: 3/5 = 0.6
   * // consumptionRatio = min(0.8, 0.6) = 0.6 (60%)
   * consumes: [
   *   { resourceId: 'energy', rate: 10 },
   *   { resourceId: 'fuel', rate: 5 }
   * ]
   *
   * @example
   * // Full consumption available - no scaling
   * // consumptionRatio = 1.0 (100%)
   * consumes: [{ resourceId: 'energy', rate: 10 }] // 10+ energy available
   */
  readonly consumes: readonly GeneratorProductionRate[];
}

/**
 * Extended System interface that includes production-specific methods.
 */
export interface ProductionSystem extends System {
  /**
   * Clears all accumulated fractional amounts.
   *
   * This is useful when you need to reset the internal accumulator state:
   * - After prestige resets, to prevent stale fractional amounts from being applied
   * - When generators change significantly (e.g., upgrades that drastically alter rates)
   * - When you want to ensure fresh accumulation starts from zero
   *
   * @remarks
   * Accumulators are not automatically cleaned up when generators are removed.
   * For games with many dynamic/temporary generators, call clearAccumulators() periodically
   * or after removing generators to free memory. For typical idle games with static generators, this is not a concern.
   *
   * @example
   * ```typescript
   * // After a prestige reset
   * productionSystem.clearAccumulators();
   * ```
   */
  clearAccumulators(): void;

  /**
   * Removes accumulator entries that have effectively zero value.
   *
   * Unlike `clearAccumulators()` which removes ALL entries, this method only
   * removes entries with negligible values (below the threshold). This is useful
   * for freeing memory from removed generators while preserving valid in-progress
   * accumulations.
   *
   * @remarks
   * Call this after removing generators to free memory without disrupting
   * active production. Entries are considered "effectively zero" if their
   * absolute value is less than threshold * 1e-6.
   *
   * @example
   * ```typescript
   * // After removing some generators
   * productionSystem.cleanupAccumulators();
   * ```
   */
  cleanupAccumulators(): void;

  /**
   * Removes all accumulator entries for a specific generator.
   *
   * Call this when a generator is removed from the game to free memory
   * associated with that generator's accumulated fractional amounts.
   *
   * @param generatorId - The ID of the generator whose accumulators should be removed
   *
   * @example
   * ```typescript
   * // When removing a generator
   * gameState.removeGenerator('gold-mine');
   * productionSystem.clearGeneratorAccumulators('gold-mine');
   * ```
   */
  clearGeneratorAccumulators(generatorId: string): void;

  /**
   * Exports accumulator state for persistence.
   *
   * Call this when saving game state to preserve fractional amounts that
   * haven't yet reached the apply threshold. Without this, small accumulated
   * amounts would be lost on save/load.
   *
   * @returns Serialized accumulator state suitable for JSON storage
   *
   * @example
   * ```typescript
   * // When saving game state
   * const saveData = {
   *   resources: resourceState.exportForSave(),
   *   productionAccumulators: productionSystem.exportAccumulators(),
   * };
   * ```
   */
  exportAccumulators(): SerializedProductionAccumulators;

  /**
   * Restores accumulator state from a previous save.
   *
   * Call this after loading game state to restore fractional amounts.
   * Invalid or unknown accumulator keys are silently ignored for
   * forward compatibility.
   *
   * @param state - Previously exported accumulator state
   *
   * @example
   * ```typescript
   * // When loading game state
   * if (saveData.productionAccumulators) {
   *   productionSystem.restoreAccumulators(saveData.productionAccumulators);
   * }
   * ```
   */
  restoreAccumulators(state: SerializedProductionAccumulators): void;

  /**
   * Applies a single offline delta without stepping through the runtime loop.
   *
   * Intended for offline fast paths so accumulators stay in sync with resources.
   */
  applyOfflineDelta?(deltaMs: number): void;
}

/**
 * Default system ID used for telemetry and resource spend tracking.
 */
const DEFAULT_PRODUCTION_SYSTEM_ID = 'production';

/**
 * Configuration options for creating a production system.
 */
export interface ProductionSystemOptions {
  /**
   * Function that returns the current generator states.
   * Called each tick to get fresh generator data.
   */
  readonly generators: () => readonly GeneratorProductionState[];
  /**
   * The resource state to apply production/consumption to.
   * Accepts any object implementing ProductionResourceState, including the full ResourceState.
   */
  readonly resourceState: ProductionResourceState;
  /**
   * Unique identifier for this production system.
   * Used for the system's `id` property and recorded in telemetry when
   * resources are consumed. Defaults to "production" when omitted.
   *
   * Specify a unique ID when creating multiple production systems to
   * distinguish their resource operations in telemetry and debugging.
   *
   * @default "production"
   */
  readonly systemId?: string;
  /**
   * Optional function to get a production multiplier for a generator.
   * Can be used to apply upgrade bonuses.
   * @returns Multiplier value (defaults to 1 if not provided)
   */
  readonly getMultiplier?: (generatorId: string) => number;
  /**
   * Minimum amount to apply to resources per tick.
   *
   * Fractional amounts below this threshold are accumulated internally
   * and applied once they reach the threshold. This prevents floating-point
   * drift while allowing smooth resource updates.
   *
   * @example
   * // Apply changes in increments of 0.01 (good for displayed values)
   * applyThreshold: 0.01
   *
   * @example
   * // Apply changes in increments of 1 (whole units only)
   * applyThreshold: 1
   *
   * @default 0.0001
   */
  readonly applyThreshold?: number;
  /**
   * When enabled, the system also populates per-second income/expense buffers
   * by calling `resourceState.applyIncome/applyExpense` (when available).
   *
   * Note: if the provided `resourceState` also exposes `finalizeTick`, these
   * per-second rates may be rolled into balances during `finalizeTick(deltaMs)`.
   * To avoid double-applying when balances are mutated immediately, this option
   * is ignored for states with `finalizeTick`; use `applyViaFinalizeTick` instead.
   *
   * This option is intended for telemetry / UI (live income/expense display) and
   * does **not** change how balances are mutated.
   *
   * @default false
   */
  readonly trackRates?: boolean;
  /**
   * Apply production/consumption by queuing per-second rates (via
   * `resourceState.applyIncome/applyExpense`) and deferring balance mutations to
   * `resourceState.finalizeTick(deltaMs)`.
   *
   * This makes rate-based application an explicit opt-in so enabling `trackRates`
   * cannot silently stall balances.
   *
   * When enabled, the provided `resourceState` must support:
   * - `applyIncome` / `applyExpense` (rate tracking), and
   * - `finalizeTick` (to roll rates into balances).
   *
   * @default false
   */
  readonly applyViaFinalizeTick?: boolean;
  /**
   * Optional callback invoked after each tick with production statistics.
   *
   * Useful for debugging, metrics collection, or UI updates. The callback
   * receives the total amounts actually applied (after accumulator thresholding)
   * for each resource during the tick.
   *
   * @param stats - Production statistics for the tick
   * @param stats.produced - Map of resource IDs to total amounts produced
   * @param stats.consumed - Map of resource IDs to total amounts consumed
   *
   * @example
   * ```typescript
   * createProductionSystem({
   *   generators: () => generators,
   *   resourceState,
   *   onTick: ({ produced, consumed }) => {
   *     console.log('Produced:', Object.fromEntries(produced));
   *     console.log('Consumed:', Object.fromEntries(consumed));
   *   }
   * });
   * ```
   */
  readonly onTick?: (stats: {
    produced: Map<string, number>;
    consumed: Map<string, number>;
  }) => void;
}

/**
 * A validated production/consumption rate with resolved resource index.
 * Returned by `validateRates` after filtering invalid rates.
 */
export interface ValidatedRate {
  /** The ID of the resource */
  readonly resourceId: string;
  /** The resolved index in the resource state */
  readonly index: number;
  /** The validated rate (guaranteed positive and finite) */
  readonly rate: number;
}

/**
 * Pre-processes production/consumption rates, filtering invalid ones and resolving resource indices.
 *
 * This function is exported primarily for testing purposes, allowing consumers to
 * pre-validate their generator configurations before runtime.
 *
 * @param rates - Array of production rates to validate
 * @param resourceState - Resource state to resolve indices against
 * @returns Array of validated rates with resolved indices
 *
 * @example
 * ```typescript
 * const validated = validateRates(generator.produces, resourceState);
 * // validated contains only rates that are positive, finite, and have valid resource indices
 * ```
 */
export function validateRates(
  rates: readonly GeneratorProductionRate[],
  resourceState: ProductionResourceState,
): ValidatedRate[] {
  const validated: ValidatedRate[] = [];

  for (const { resourceId, rate } of rates) {
    if (!Number.isFinite(rate) || rate <= 0) {
      continue;
    }

    const index = resourceState.getIndex(resourceId);
    if (index === undefined) {
      continue;
    }

    validated.push({ resourceId, index, rate });
  }

  return validated;
}

type AccumulatorOperation = 'produce' | 'consume';

function serializeAccumulatorKeyLegacy(
  generatorId: string,
  operation: AccumulatorOperation,
  resourceId: string,
): string {
  return `${generatorId}:${operation}:${resourceId}`;
}

function clampRatio01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function deleteNearZeroEntries<Key>(
  map: Map<Key, number>,
  threshold: number,
): void {
  for (const [key, value] of map) {
    if (Math.abs(value) < threshold) {
      map.delete(key);
    }
  }
}

function computeRateConsumptionRatio(
  resourceState: ProductionResourceState,
  validConsumptions: readonly ValidatedRate[],
  effectiveOwned: number,
  deltaSeconds: number,
): number {
  let rateConsumptionRatio = 1;

  for (const { index, rate } of validConsumptions) {
    const required = rate * effectiveOwned * deltaSeconds;
    if (!Number.isFinite(required) || required <= 0) {
      continue;
    }

    const available = resourceState.getAmount(index);
    if (!Number.isFinite(available) || available <= 0) {
      return 0;
    }

    const ratio = available / required;
    if (Number.isFinite(ratio)) {
      rateConsumptionRatio = Math.min(rateConsumptionRatio, ratio);
    }
  }

  return clampRatio01(rateConsumptionRatio);
}

function applyRateTrackingAdjustments(
  rates: readonly ValidatedRate[],
  effectiveOwned: number,
  rateConsumptionRatio: number,
  apply: (index: number, amountPerSecond: number) => void,
): void {
  for (const { index, rate } of rates) {
    const amountPerSecond = rate * effectiveOwned * rateConsumptionRatio;
    if (Number.isFinite(amountPerSecond) && amountPerSecond > 0) {
      apply(index, amountPerSecond);
    }
  }
}

/**
 * Calculates what would be applied without modifying accumulator state.
 * Returns both the amount that would be applied and the new accumulator total.
 */
interface AccumulatorResult {
  /** Amount that would be applied this tick (threshold-aligned) */
  readonly toApply: number;
  /** Total accumulated value (for ratio calculations) */
  readonly newTotal: number;
  /** Commits the accumulator state, optionally scaling the applied amount */
  readonly commit: (scale?: number) => void;
}

/**
 * Context for executing production phases.
 * Abstracts the difference between shadow-based (finalize tick) and direct resource operations.
 */
interface PhaseContext {
  /** Get current resource amount (shadow or actual) */
  readonly getAmount: (index: number) => number;
  /**
   * Add production to a resource.
   * @returns The actual amount applied (may be less due to capacity)
   */
  readonly addProduction: (index: number, amount: number, resourceId: string) => number;
  /**
   * Spend consumption from a resource.
   * @returns true if spend succeeded, false if insufficient
   */
  readonly spendConsumption: (index: number, amount: number, resourceId: string) => boolean;
  /** Callback for tracking produced amounts */
  readonly onProduce?: (resourceId: string, amount: number) => void;
  /** Callback for tracking consumed amounts */
  readonly onConsume?: (resourceId: string, amount: number) => void;
}

/**
 * Input data for a single generator's production phase execution.
 */
interface GeneratorPhaseInput {
  readonly generatorId: string;
  readonly validProductions: readonly ValidatedRate[];
  readonly validConsumptions: readonly ValidatedRate[];
  readonly effectiveOwned: number;
  readonly deltaSeconds: number;
}

type AccumulateFunction = (
  generatorId: string,
  operation: AccumulatorOperation,
  resourceId: string,
  delta: number,
) => AccumulatorResult;

interface ConsumptionAccumulator {
  readonly resourceId: string;
  readonly index: number;
  readonly result: AccumulatorResult;
}

function prepareConsumptionPhase(
  input: GeneratorPhaseInput,
  context: PhaseContext,
  accumulate: AccumulateFunction,
): {
  consumptionAccumulators: ConsumptionAccumulator[];
  consumptionRatio: number;
  willApplyProduction: boolean;
} {
  const { generatorId, validConsumptions, effectiveOwned, deltaSeconds } = input;

  // Phase 1: Peek at what each consumption accumulator would apply
  // and calculate ratio based on ACTUAL consumable amounts (post-threshold)
  const consumptionAccumulators: ConsumptionAccumulator[] = [];

  let consumptionRatio = 1;
  // Generators without consumption requirements always produce at full rate.
  // For generators WITH consumption, we only apply production when at least
  // one consumption crosses the threshold (keeps production/consumption in sync).
  let willApplyProduction = validConsumptions.length === 0;

  for (const { resourceId, index, rate } of validConsumptions) {
    const delta = rate * effectiveOwned * deltaSeconds;
    const result = accumulate(generatorId, 'consume', resourceId, delta);
    consumptionAccumulators.push({ resourceId, index, result });

    if (result.toApply <= 0) {
      continue;
    }

    willApplyProduction = true;
    const available = context.getAmount(index);

    // Use newTotal (full accumulated amount) for ratio calculation to ensure
    // production scales correctly with actual consumption.
    consumptionRatio = Math.min(
      consumptionRatio,
      available / result.newTotal,
      available / result.toApply,
    );
  }

  return {
    consumptionAccumulators,
    consumptionRatio: clampRatio01(consumptionRatio),
    willApplyProduction,
  };
}

function executeProductionPhase(
  input: GeneratorPhaseInput,
  context: PhaseContext,
  accumulate: AccumulateFunction,
  consumptionRatio: number,
  willApplyProduction: boolean,
): void {
  const { generatorId, validProductions, effectiveOwned, deltaSeconds } = input;
  const scale = willApplyProduction ? consumptionRatio : 0;

  // Phase 2: Accumulate production at full rate, apply scaled by consumption ratio
  for (const { resourceId, index, rate } of validProductions) {
    const delta = rate * effectiveOwned * deltaSeconds;
    const result = accumulate(generatorId, 'produce', resourceId, delta);
    result.commit(scale);

    const actualToApply = result.toApply * scale;
    if (actualToApply <= 0) {
      continue;
    }

    const applied = context.addProduction(index, actualToApply, resourceId);
    if (applied > 0) {
      context.onProduce?.(resourceId, applied);
    }
  }
}

function executeConsumptionPhase(
  context: PhaseContext,
  consumptionAccumulators: readonly ConsumptionAccumulator[],
  consumptionRatio: number,
): void {
  // Phase 3: Apply consumption, scaling by ratio if resources were limited
  for (const { resourceId, index, result } of consumptionAccumulators) {
    result.commit(consumptionRatio);

    const actualToApply = result.toApply * consumptionRatio;
    if (actualToApply <= 0) {
      continue;
    }

    if (!context.spendConsumption(index, actualToApply, resourceId)) {
      continue;
    }

    context.onConsume?.(resourceId, actualToApply);
  }
}

/**
 * Executes the three production phases for a single generator.
 *
 * Phase 1: Calculate consumption ratios based on available resources
 * Phase 2: Apply production scaled by consumption ratio
 * Phase 3: Apply consumption scaled by ratio
 */
function executeProductionPhases(
  input: GeneratorPhaseInput,
  context: PhaseContext,
  accumulate: AccumulateFunction,
): void {
  const { consumptionAccumulators, consumptionRatio, willApplyProduction } =
    prepareConsumptionPhase(input, context, accumulate);

  executeProductionPhase(
    input,
    context,
    accumulate,
    consumptionRatio,
    willApplyProduction,
  );
  executeConsumptionPhase(context, consumptionAccumulators, consumptionRatio);
}

function createShadowPhaseContext(
  getAmount: (index: number) => number,
  addAmount: (index: number, amount: number) => number,
  spendAmount: (index: number, amount: number) => boolean,
  produced: Map<string, number>,
  consumed: Map<string, number>,
  onTick: boolean,
): PhaseContext {
  return {
    getAmount,
    addProduction: (index, amount) => addAmount(index, amount),
    spendConsumption: (index, amount) => spendAmount(index, amount),
    onProduce: onTick
      ? (resourceId, amount) => {
          produced.set(resourceId, (produced.get(resourceId) ?? 0) + amount);
        }
      : undefined,
    onConsume: onTick
      ? (resourceId, amount) => {
          consumed.set(resourceId, (consumed.get(resourceId) ?? 0) + amount);
        }
      : undefined,
  };
}

function createDirectPhaseContext(
  resourceState: ProductionResourceState,
  systemId: string,
  produced: Map<string, number>,
  consumed: Map<string, number>,
  onTick: boolean,
): PhaseContext {
  return {
    getAmount: (index) => resourceState.getAmount(index),
    addProduction: (index, amount) => {
      const before = resourceState.getAmount(index);
      const applied = (
        resourceState as unknown as {
          addAmount: (index: number, amount: number) => unknown;
        }
      ).addAmount(index, amount);

      if (typeof applied === 'number') {
        if (!Number.isFinite(applied) || applied <= 0) {
          return 0;
        }
        return applied;
      }

      const after = resourceState.getAmount(index);
      if (!Number.isFinite(before) || !Number.isFinite(after)) {
        return amount;
      }

      const delta = after - before;
      if (!Number.isFinite(delta) || delta <= 0) {
        return 0;
      }
      return Math.min(delta, amount);
    },
    spendConsumption: (index, amount) => {
      return resourceState.spendAmount(index, amount, { systemId });
    },
    onProduce: onTick
      ? (resourceId, amount) => {
          produced.set(resourceId, (produced.get(resourceId) ?? 0) + amount);
        }
      : undefined,
    onConsume: onTick
      ? (resourceId, amount) => {
          consumed.set(resourceId, (consumed.get(resourceId) ?? 0) + amount);
        }
      : undefined,
  };
}

/**
 * Manages shadow state for finalize-tick-based production.
 * Tracks pending changes in memory before committing via finalizeTick.
 */
class ShadowState {
  private readonly amounts = new Map<number, number>();
  private readonly income = new Map<number, number>();
  private readonly expense = new Map<number, number>();

  constructor(
    private readonly resourceState: ProductionResourceState,
    private readonly capacityState: ProductionResourceStateWithCapacity | undefined,
  ) {}

  getAmount(index: number): number {
    return this.amounts.get(index) ?? this.resourceState.getAmount(index);
  }

  addAmount(index: number, amount: number): number {
    const current = this.getAmount(index);
    const capacity = this.getCapacity(index);
    const next = this.clampAmount(current + amount, capacity);
    this.amounts.set(index, next);

    const applied = next - current;
    if (applied > 0) {
      this.recordIncome(index, applied);
    }
    return applied;
  }

  spendAmount(index: number, amount: number): boolean {
    const current = this.getAmount(index);
    if (current < amount) {
      return false;
    }

    this.amounts.set(index, current - amount);
    this.recordExpense(index, amount);
    return true;
  }

  getIncome(): ReadonlyMap<number, number> {
    return this.income;
  }

  getExpense(): ReadonlyMap<number, number> {
    return this.expense;
  }

  private getCapacity(index: number): number {
    if (!this.capacityState) {
      return Number.POSITIVE_INFINITY;
    }

    const capacity = this.capacityState.getCapacity(index);
    if (capacity === Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY;
    }
    if (!Number.isFinite(capacity) || capacity < 0) {
      return Number.POSITIVE_INFINITY;
    }
    return capacity;
  }

  private clampAmount(amount: number, capacity: number): number {
    if (amount < 0) {
      return 0;
    }
    if (amount > capacity) {
      return capacity;
    }
    return amount;
  }

  private recordIncome(index: number, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.income.set(index, (this.income.get(index) ?? 0) + amount);
  }

  private recordExpense(index: number, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.expense.set(index, (this.expense.get(index) ?? 0) + amount);
  }
}

/**
 * Creates a production system that applies generator produces/consumes rates
 * to resources each tick.
 *
 * The system calculates production as: rate * owned * multiplier * deltaSeconds * consumptionRatio
 *
 * ## Consumption Ratio Behavior
 *
 * When a generator has consumption requirements (consumes array), production is
 * automatically throttled based on available input resources. The system:
 *
 * 1. Calculates the ratio of available/required for each consumed resource
 * 2. Takes the minimum ratio across all consumed resources (consumptionRatio)
 * 3. Scales both production AND consumption by this ratio
 *
 * This ensures generators operate at reduced efficiency when inputs are limited,
 * rather than stopping completely or consuming more than available.
 *
 * @remarks
 * **Consumption Ratio Formula:**
 * ```
 * consumptionRatio = min(available[i] / (rate[i] * owned * multiplier * deltaSeconds))
 * ```
 * where i iterates over all consumed resources.
 *
 * **Scaling Formula:**
 * ```
 * actualProduction = baseProduction * consumptionRatio
 * actualConsumption = baseConsumption * consumptionRatio
 * ```
 *
 * @example
 * **Example 1: Single consumption requirement with limited input**
 * ```typescript
 * // Generator produces 10 metal/s, consumes 5 energy/s
 * // Only 2.5 energy available this tick (0.5s * 5 = 2.5 needed)
 * const generator = {
 *   id: 'smelter',
 *   owned: 1,
 *   produces: [{ resourceId: 'metal', rate: 10 }],
 *   consumes: [{ resourceId: 'energy', rate: 5 }]
 * };
 * // With only 1.25 energy available for a 0.5s tick:
 * // consumptionRatio = 1.25 / 2.5 = 0.5
 * // Produces: 10 * 1 * 1 * 0.5 * 0.5 = 2.5 metal (instead of 5)
 * // Consumes: 5 * 1 * 1 * 0.5 * 0.5 = 1.25 energy (instead of 2.5)
 * ```
 *
 * @example
 * **Example 2: Multiple consumption requirements**
 * ```typescript
 * // Generator needs both energy and fuel
 * const generator = {
 *   id: 'refinery',
 *   owned: 1,
 *   produces: [{ resourceId: 'output', rate: 20 }],
 *   consumes: [
 *     { resourceId: 'energy', rate: 10 },  // Need 10/s
 *     { resourceId: 'fuel', rate: 5 }      // Need 5/s
 *   ]
 * };
 * // For a 1s tick with energy: 8 available, fuel: 3 available
 * // energyRatio = 8 / 10 = 0.8
 * // fuelRatio = 3 / 5 = 0.6
 * // consumptionRatio = min(0.8, 0.6) = 0.6
 * // Produces: 20 * 1 * 1 * 1 * 0.6 = 12 output (instead of 20)
 * // Consumes: 10 * 0.6 = 6 energy, 5 * 0.6 = 3 fuel
 * ```
 *
 * @example
 * **Example 3: Full consumption available**
 * ```typescript
 * // Generator with abundant inputs
 * const generator = {
 *   id: 'generator',
 *   owned: 1,
 *   produces: [{ resourceId: 'power', rate: 100 }],
 *   consumes: [{ resourceId: 'fuel', rate: 10 }]
 * };
 * // For a 1s tick with fuel: 50 available (need only 10)
 * // fuelRatio = 50 / 10 = 5.0, but consumptionRatio clamped at 1.0
 * // consumptionRatio = 1.0 (no throttling)
 * // Produces: 100 * 1 * 1 * 1 * 1.0 = 100 power (full rate)
 * // Consumes: 10 * 1 * 1 * 1 * 1.0 = 10 fuel (full rate)
 * ```
 *
 * @example
 * **Basic usage:**
 * ```typescript
 * import { createProductionSystem } from '@idle-engine/core/internals';
 *
 * const productionSystem = createProductionSystem({
 *   generators: () => progressionCoordinator.state.generators,
 *   resourceState: progressionCoordinator.resourceState,
 *   getMultiplier: (generatorId) => upgradeMultipliers.get(generatorId) ?? 1,
 * });
 *
 * runtime.addSystem(productionSystem);
 * ```
 *
 * ## Accumulator Memory Management
 *
 * The production system maintains internal accumulators to track fractional amounts
 * below the `applyThreshold`. These accumulators are keyed by generator ID and resource ID,
 * meaning **memory grows with the number of unique generator/resource combinations**.
 *
 * **Important:** Accumulators are NOT automatically cleaned up when generators are removed.
 * For games with dynamic generators (created/destroyed at runtime), you should manage
 * accumulator memory using these methods:
 *
 * - `clearGeneratorAccumulators(generatorId)` - Call when removing a specific generator
 * - `cleanupAccumulators()` - Removes entries with near-zero values (safe to call periodically)
 * - `clearAccumulators()` - Removes ALL entries (use after prestige resets)
 *
 * For typical idle games with a fixed set of generators, this is not a concern.
 *
 * @example
 * **Memory management for dynamic generators:**
 * ```typescript
 * // When removing a generator
 * gameState.removeGenerator('temporary-boost');
 * productionSystem.clearGeneratorAccumulators('temporary-boost');
 *
 * // After prestige reset
 * productionSystem.clearAccumulators();
 * ```
 *
 * @param options - Configuration options
 * @returns A ProductionSystem that can be added to the runtime
 */
export function createProductionSystem(
  options: ProductionSystemOptions,
): ProductionSystem {
  const { generators, resourceState, getMultiplier, onTick } = options;
  const systemId = options.systemId ?? DEFAULT_PRODUCTION_SYSTEM_ID;
  const applyThreshold = options.applyThreshold ?? 0.0001;
  const rateTrackingState = supportsRateTracking(resourceState)
    ? resourceState
    : undefined;
  const hasFinalizeTick = supportsFinalizeTick(resourceState);
  const applyViaFinalizeTick = options.applyViaFinalizeTick === true;
  const trackRates = options.trackRates === true || applyViaFinalizeTick;
  const useFinalizeTickRates =
    applyViaFinalizeTick &&
    rateTrackingState !== undefined &&
    hasFinalizeTick;

  if (applyThreshold <= 0 || !Number.isFinite(applyThreshold)) {
    throw new Error('applyThreshold must be a positive finite number');
  }

  if (applyViaFinalizeTick && !useFinalizeTickRates) {
    throw new Error(
      'applyViaFinalizeTick requires resourceState.applyIncome/applyExpense and resourceState.finalizeTick.',
    );
  }

  // Track accumulated fractional amounts per generator/resource
  const accumulators = new Map<
    string,
    {
      readonly produce: Map<string, number>;
      readonly consume: Map<string, number>;
    }
  >();
  const legacyAccumulators = new Map<string, number>();

  const ACCUMULATOR_KEY_V2_PREFIX = 'v2|';

    function serializeAccumulatorKeyV2(
      generatorId: string,
      operation: AccumulatorOperation,
      resourceId: string,
    ): string {
    return [
      ACCUMULATOR_KEY_V2_PREFIX.slice(0, -1),
      encodeURIComponent(generatorId),
      operation,
      encodeURIComponent(resourceId),
      ].join('|');
    }

  function tryParseAccumulatorKeyV2(
    key: string,
  ):
    | {
        generatorId: string;
        operation: AccumulatorOperation;
        resourceId: string;
      }
    | undefined {
    if (!key.startsWith(ACCUMULATOR_KEY_V2_PREFIX)) {
      return undefined;
    }

    const parts = key.split('|');
    if (parts.length !== 4 || parts[0] !== 'v2') {
      return undefined;
    }

    const operation = parts[2];
    if (operation !== 'produce' && operation !== 'consume') {
      return undefined;
    }

    try {
      return {
        generatorId: decodeURIComponent(parts[1]),
        operation,
        resourceId: decodeURIComponent(parts[3]),
      };
    } catch {
      return undefined;
    }
  }

  function hasAccumulatorValue(
    generatorId: string,
    operation: AccumulatorOperation,
    resourceId: string,
  ): boolean {
    const generatorAccumulators = accumulators.get(generatorId);
    if (!generatorAccumulators) {
      return false;
    }

    const accumulatorMap =
      operation === 'produce'
        ? generatorAccumulators.produce
        : generatorAccumulators.consume;
    return accumulatorMap.has(resourceId);
  }

  function setAccumulatorValueFromRestore(
    generatorId: string,
    operation: AccumulatorOperation,
    resourceId: string,
    value: number,
  ): void {
    const generatorAccumulators = accumulators.get(generatorId) ?? {
      produce: new Map<string, number>(),
      consume: new Map<string, number>(),
    };
    accumulators.set(generatorId, generatorAccumulators);

    const accumulatorMap =
      operation === 'produce'
        ? generatorAccumulators.produce
        : generatorAccumulators.consume;
    accumulatorMap.set(resourceId, value);
  }

  function tryParseAccumulatorKeyLegacy(
    key: string,
    generatorIds: ReadonlySet<string>,
  ):
    | {
        generatorId: string;
        operation: AccumulatorOperation;
        resourceId: string;
      }
    | undefined {
    const candidates: Array<{
      generatorId: string;
      operation: AccumulatorOperation;
      resourceId: string;
    }> = [];

    const operations: AccumulatorOperation[] = ['produce', 'consume'];
    for (const operation of operations) {
      const delimiter = `:${operation}:`;
      let searchIndex = 0;
      while (true) {
        const delimiterIndex = key.indexOf(delimiter, searchIndex);
        if (delimiterIndex === -1) {
          break;
        }

        const generatorId = key.slice(0, delimiterIndex);
        const resourceId = key.slice(delimiterIndex + delimiter.length);
        if (generatorId.length > 0 && resourceId.length > 0) {
          candidates.push({ generatorId, operation, resourceId });
        }

        searchIndex = delimiterIndex + 1;
      }
    }

    const candidatesWithKnownResource = candidates.filter(
      ({ resourceId }) => resourceState.getIndex(resourceId) !== undefined,
    );
    if (candidatesWithKnownResource.length === 0) {
      return undefined;
    }

    const candidatesWithKnownGenerator = candidatesWithKnownResource.filter(
      ({ generatorId }) => generatorIds.has(generatorId),
    );
    if (candidatesWithKnownGenerator.length === 1) {
      return candidatesWithKnownGenerator[0];
    }

    if (candidatesWithKnownResource.length === 1) {
      return candidatesWithKnownResource[0];
    }

    return undefined;
  }

  /**
   * Accumulates a delta and returns the threshold-aligned amount to apply.
   * Call commit() to finalize the accumulator state after deciding the scale.
   */
  function accumulate(
    generatorId: string,
    operation: AccumulatorOperation,
    resourceId: string,
    delta: number,
  ): AccumulatorResult {
    const generatorAccumulators = accumulators.get(generatorId) ?? {
      produce: new Map<string, number>(),
      consume: new Map<string, number>(),
    };
    accumulators.set(generatorId, generatorAccumulators);

    const accumulatorMap =
      operation === 'produce'
        ? generatorAccumulators.produce
        : generatorAccumulators.consume;

    let current = accumulatorMap.get(resourceId) ?? 0;
    if (legacyAccumulators.size > 0) {
      const legacyKey = serializeAccumulatorKeyLegacy(generatorId, operation, resourceId);
      const legacyValue = legacyAccumulators.get(legacyKey);
      if (legacyValue !== undefined) {
        legacyAccumulators.delete(legacyKey);
        current = legacyValue;
        accumulatorMap.set(resourceId, legacyValue);
      }
    }

    const total = current + delta;
    // Use a small epsilon to handle floating-point precision issues
    // (e.g., 0.09 + 0.01 = 0.09999999999999999 should count as 0.10)
    // 1e-9 is orders of magnitude larger than float64 machine epsilon (~2.2e-16)
    // but still negligible relative to any practical threshold value.
    const epsilon = applyThreshold * 1e-9;
    const toApply = Math.floor((total + epsilon) / applyThreshold) * applyThreshold;

    return {
      toApply,
      newTotal: total,
      commit: (scale = 1) => {
        // Store the difference between total accumulated and what was actually applied.
        // This preserves both the sub-threshold remainder and any portion not applied due to scaling.
        accumulatorMap.set(resourceId, total - toApply * scale);
      },
    };
  }

    const shouldTrackTickStats = onTick !== undefined;

    const applyDirectRateTracking = (
      rateState: ProductionResourceStateWithRateTracking,
      validProductions: readonly ValidatedRate[],
      validConsumptions: readonly ValidatedRate[],
      effectiveOwned: number,
      deltaSeconds: number,
    ): void => {
      const rateConsumptionRatio = computeRateConsumptionRatio(
        resourceState,
        validConsumptions,
        effectiveOwned,
        deltaSeconds,
      );
      if (rateConsumptionRatio <= 0) {
        return;
      }

      applyRateTrackingAdjustments(
        validProductions,
        effectiveOwned,
        rateConsumptionRatio,
        (index, amountPerSecond) => {
          rateState.applyIncome(index, amountPerSecond);
        },
      );
      applyRateTrackingAdjustments(
        validConsumptions,
        effectiveOwned,
        rateConsumptionRatio,
        (index, amountPerSecond) => {
          rateState.applyExpense(index, amountPerSecond);
        },
      );
    };

  const runFinalizeTickRatesFlow = (
    rateState: ProductionResourceStateWithRateTracking,
    generatorList: readonly GeneratorProductionState[],
    deltaSeconds: number,
    produced: Map<string, number>,
    consumed: Map<string, number>,
  ): void => {
    const shadowState = new ShadowState(
      resourceState,
      supportsCapacity(resourceState) ? resourceState : undefined,
    );

    const shadowContext = createShadowPhaseContext(
      (index) => shadowState.getAmount(index),
      (index, amount) => shadowState.addAmount(index, amount),
      (index, amount) => shadowState.spendAmount(index, amount),
      produced,
      consumed,
      shouldTrackTickStats,
    );

    for (const generator of generatorList) {
      if (generator.owned <= 0) {
        continue;
      }
      if (generator.enabled === false) {
        continue;
      }

      const multiplier = getMultiplier?.(generator.id) ?? 1;
      const effectiveOwned = generator.owned * multiplier;

      const validProductions = validateRates(generator.produces, resourceState);
      const validConsumptions = validateRates(generator.consumes, resourceState);

      executeProductionPhases(
        {
          generatorId: generator.id,
          validProductions,
          validConsumptions,
          effectiveOwned,
          deltaSeconds,
        },
        shadowContext,
        accumulate,
      );
    }

    for (const [index, amount] of shadowState.getIncome()) {
      const amountPerSecond = amount / deltaSeconds;
      if (Number.isFinite(amountPerSecond) && amountPerSecond > 0) {
        rateState.applyIncome(index, amountPerSecond);
      }
    }

    for (const [index, amount] of shadowState.getExpense()) {
      const amountPerSecond = amount / deltaSeconds;
      if (Number.isFinite(amountPerSecond) && amountPerSecond > 0) {
        rateState.applyExpense(index, amountPerSecond);
      }
    }
  };

  const runStandardFlow = (
    generatorList: readonly GeneratorProductionState[],
    deltaSeconds: number,
    produced: Map<string, number>,
    consumed: Map<string, number>,
  ): void => {
    const directContext = createDirectPhaseContext(
      resourceState,
      systemId,
      produced,
      consumed,
      shouldTrackTickStats,
    );

    for (const generator of generatorList) {
      if (generator.owned <= 0) {
        continue;
      }
      if (generator.enabled === false) {
        continue;
      }

      const multiplier = getMultiplier?.(generator.id) ?? 1;
      const effectiveOwned = generator.owned * multiplier;

      const validProductions = validateRates(generator.produces, resourceState);
      const validConsumptions = validateRates(generator.consumes, resourceState);

      if (trackRates && rateTrackingState && !hasFinalizeTick) {
        applyDirectRateTracking(
          rateTrackingState,
          validProductions,
          validConsumptions,
          effectiveOwned,
          deltaSeconds,
        );
      }

      executeProductionPhases(
        {
          generatorId: generator.id,
          validProductions,
          validConsumptions,
          effectiveOwned,
          deltaSeconds,
        },
        directContext,
        accumulate,
      );
    }
  };

  const runTick = (deltaMs: number): void => {
    const deltaSeconds = deltaMs / 1000;
    const generatorList = generators();

    const produced = new Map<string, number>();
    const consumed = new Map<string, number>();

    if (useFinalizeTickRates && rateTrackingState) {
      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
        onTick?.({ produced, consumed });
        return;
      }

      runFinalizeTickRatesFlow(
        rateTrackingState,
        generatorList,
        deltaSeconds,
        produced,
        consumed,
      );

      onTick?.({ produced, consumed });
      return;
    }

    runStandardFlow(generatorList, deltaSeconds, produced, consumed);
    onTick?.({ produced, consumed });
  };

  const tick: ProductionSystem['tick'] = ({ deltaMs }) => {
    runTick(deltaMs);
  };

  const applyOfflineDelta = (deltaMs: number): void => {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return;
    }

    runTick(deltaMs);

    if (useFinalizeTickRates) {
      resourceState.finalizeTick(deltaMs);
    }

    if (trackRates && supportsPerTickReset(resourceState)) {
      resourceState.snapshot({ mode: 'publish' });
      resourceState.resetPerTickAccumulators();
    }
  };

  return {
    id: systemId,
    tick,
    applyOfflineDelta,
    clearAccumulators: () => {
      accumulators.clear();
      legacyAccumulators.clear();
    },
      cleanupAccumulators: () => {
        const zeroThreshold = applyThreshold * 1e-6;
        for (const [generatorId, generatorAccumulators] of accumulators) {
          deleteNearZeroEntries(generatorAccumulators.produce, zeroThreshold);
          deleteNearZeroEntries(generatorAccumulators.consume, zeroThreshold);

          if (
            generatorAccumulators.produce.size === 0 &&
            generatorAccumulators.consume.size === 0
          ) {
            accumulators.delete(generatorId);
          }
        }
        deleteNearZeroEntries(legacyAccumulators, zeroThreshold);
      },
    clearGeneratorAccumulators: (generatorId: string) => {
      accumulators.delete(generatorId);

      const producePrefix = `${generatorId}:produce:`;
      const consumePrefix = `${generatorId}:consume:`;

      for (const key of legacyAccumulators.keys()) {
        if (key.startsWith(producePrefix) || key.startsWith(consumePrefix)) {
          legacyAccumulators.delete(key);
        }
      }
    },
    exportAccumulators: (): SerializedProductionAccumulators => {
      const result: Record<string, number> = {};

      for (const [generatorId, generatorAccumulators] of accumulators) {
        for (const [resourceId, value] of generatorAccumulators.produce) {
          // Only export non-zero values to minimize save size
          if (value !== 0) {
            result[serializeAccumulatorKeyV2(generatorId, 'produce', resourceId)] = value;
          }
        }

        for (const [resourceId, value] of generatorAccumulators.consume) {
          // Only export non-zero values to minimize save size
          if (value !== 0) {
            result[serializeAccumulatorKeyV2(generatorId, 'consume', resourceId)] = value;
          }
        }
      }

      for (const [key, value] of legacyAccumulators) {
        // Only export non-zero values to minimize save size
        if (value !== 0) {
          result[key] = value;
        }
      }

      return { accumulators: result };
    },
      restoreAccumulators: (state: SerializedProductionAccumulators) => {
        accumulators.clear();
        legacyAccumulators.clear();

      if (!state || !state.accumulators) {
        return;
      }

        const generatorIds = new Set(generators().map((generator) => generator.id));

        // Restore each accumulator, filtering out invalid values
        for (const [key, value] of Object.entries(state.accumulators)) {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            continue;
          }

          const v2Parsed = tryParseAccumulatorKeyV2(key);
          if (v2Parsed) {
            setAccumulatorValueFromRestore(
              v2Parsed.generatorId,
              v2Parsed.operation,
              v2Parsed.resourceId,
              value,
            );
            continue;
          }

          const legacyParsed = tryParseAccumulatorKeyLegacy(key, generatorIds);
          if (!legacyParsed) {
            legacyAccumulators.set(key, value);
            continue;
          }

          if (
            hasAccumulatorValue(
              legacyParsed.generatorId,
              legacyParsed.operation,
              legacyParsed.resourceId,
            )
          ) {
            continue;
          }

          setAccumulatorValueFromRestore(
            legacyParsed.generatorId,
            legacyParsed.operation,
            legacyParsed.resourceId,
            value,
          );
        }
      },
    };
}
