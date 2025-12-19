import type {
  NormalizedUpgrade,
  NumericFormula,
} from '@idle-engine/content-schema';
import {
  evaluateNumericFormula,
  type FormulaEvaluationContext,
} from '@idle-engine/content-schema';

export type UpgradeEffectEvaluatorContext = Readonly<{
  readonly step: number;
  readonly createFormulaEvaluationContext: (
    level: number,
    step: number,
  ) => FormulaEvaluationContext;
  readonly getBaseCapacity: (resourceId: string) => number;
  readonly getBaseDirtyTolerance: (resourceId: string) => number;
  readonly onError?: (error: Error) => void;
}>;

export type UpgradeEffectSource = Readonly<{
  readonly definition: NormalizedUpgrade;
  readonly purchases: number;
}>;

export type EvaluatedUpgradeEffects = Readonly<{
  readonly generatorRateMultipliers: ReadonlyMap<string, number>;
  readonly generatorCostMultipliers: ReadonlyMap<string, number>;
  readonly resourceRateMultipliers: ReadonlyMap<string, number>;
  readonly resourceCapacityOverrides: ReadonlyMap<string, number>;
  readonly dirtyToleranceOverrides: ReadonlyMap<string, number>;
  readonly unlockedResources: ReadonlySet<string>;
  readonly unlockedGenerators: ReadonlySet<string>;
  readonly grantedAutomations: ReadonlySet<string>;
  readonly grantedFlags: ReadonlyMap<string, boolean>;
}>;

type AdjustmentOperation = 'add' | 'multiply' | 'set';

function evaluateFiniteNumericFormula(
  formula: NumericFormula,
  context: FormulaEvaluationContext,
  onError: ((error: Error) => void) | undefined,
  errorPrefix: string,
): number | undefined {
  try {
    const value = evaluateNumericFormula(formula, context);
    if (!Number.isFinite(value)) {
      onError?.(new Error(`${errorPrefix} returned invalid value: ${value}`));
      return undefined;
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError?.(new Error(`${errorPrefix} failed: ${message}`));
    return undefined;
  }
}

function applyOperation(
  current: number,
  operation: AdjustmentOperation,
  effectiveValue: number,
): number | undefined {
  switch (operation) {
    case 'add':
      return current + effectiveValue;
    case 'multiply':
      return current * effectiveValue;
    case 'set':
      return effectiveValue;
    default: {
      const _exhaustive: never = operation;
      return _exhaustive;
    }
  }
}

function applyModifier(
  modifiers: Map<string, number>,
  targetId: string,
  operation: AdjustmentOperation,
  effectiveValue: number,
  onError: ((error: Error) => void) | undefined,
  errorPrefix: string,
): void {
  const current = modifiers.get(targetId) ?? 1;
  const next = applyOperation(current, operation, effectiveValue);
  if (next === undefined) {
    onError?.(
      new Error(
        `${errorPrefix} encountered unknown operation "${String(operation)}".`,
      ),
    );
    return;
  }
  modifiers.set(targetId, next);
}

function applyDirtyToleranceOverride(
  overrides: Map<string, number>,
  getBase: (resourceId: string) => number,
  resourceId: string,
  operation: AdjustmentOperation,
  effectiveValue: number,
  onError: ((error: Error) => void) | undefined,
  errorPrefix: string,
): void {
  const current = overrides.has(resourceId)
    ? (overrides.get(resourceId) ?? getBase(resourceId))
    : getBase(resourceId);
  const next = applyOperation(current, operation, effectiveValue);
  if (next === undefined) {
    onError?.(
      new Error(
        `${errorPrefix} encountered unknown operation "${String(operation)}".`,
      ),
    );
    return;
  }
  overrides.set(resourceId, next);
}

function applyCapacityOperation(
  current: number,
  operation: AdjustmentOperation,
  effectiveValue: number,
): number | undefined {
  if (current === Number.POSITIVE_INFINITY) {
    switch (operation) {
      case 'add':
      case 'multiply':
        return Number.POSITIVE_INFINITY;
      case 'set':
        return effectiveValue;
      default: {
        const _exhaustive: never = operation;
        return _exhaustive;
      }
    }
  }
  return applyOperation(current, operation, effectiveValue);
}

function applyCapacityOverride(
  overrides: Map<string, number>,
  getBase: (resourceId: string) => number,
  resourceId: string,
  operation: AdjustmentOperation,
  effectiveValue: number,
  onError: ((error: Error) => void) | undefined,
  errorPrefix: string,
): void {
  if (operation === 'multiply' && effectiveValue < 0) {
    onError?.(
      new Error(`${errorPrefix} cannot use a negative multiplier.`),
    );
    return;
  }

  const current = overrides.has(resourceId)
    ? (overrides.get(resourceId) ?? getBase(resourceId))
    : getBase(resourceId);
  const next = applyCapacityOperation(current, operation, effectiveValue);
  if (next === undefined) {
    onError?.(
      new Error(
        `${errorPrefix} encountered unknown operation "${String(operation)}".`,
      ),
    );
    return;
  }
  if (!Number.isFinite(next) && next !== Number.POSITIVE_INFINITY) {
    onError?.(
      new Error(`${errorPrefix} returned invalid capacity: ${next}`),
    );
    return;
  }
  if (next < 0) {
    onError?.(
      new Error(`${errorPrefix} cannot resolve to a negative capacity.`),
    );
    return;
  }
  overrides.set(resourceId, next);
}

export function evaluateUpgradeEffects(
  upgrades: readonly UpgradeEffectSource[],
  context: UpgradeEffectEvaluatorContext,
): EvaluatedUpgradeEffects {
  const generatorRateMultipliers = new Map<string, number>();
  const generatorCostMultipliers = new Map<string, number>();
  const resourceRateMultipliers = new Map<string, number>();
  const resourceCapacityOverrides = new Map<string, number>();
  const dirtyToleranceOverrides = new Map<string, number>();
  const unlockedResources = new Set<string>();
  const unlockedGenerators = new Set<string>();
  const grantedAutomations = new Set<string>();
  const grantedFlags = new Map<string, boolean>();

  for (const record of upgrades) {
    if (record.purchases <= 0) {
      continue;
    }

    for (const effect of record.definition.effects) {
      switch (effect.kind) {
        case 'unlockResource':
          unlockedResources.add(effect.resourceId);
          break;
        case 'unlockGenerator':
          unlockedGenerators.add(effect.generatorId);
          break;
        case 'grantAutomation':
          grantedAutomations.add(effect.automationId);
          break;
        case 'grantFlag':
          grantedFlags.set(effect.flagId, effect.value);
          break;
        default:
          break;
      }
    }

    const purchases = record.purchases;
    const repeatableConfig = record.definition.repeatable;
    const isRepeatable = repeatableConfig !== undefined;
    const effectCurve = repeatableConfig?.effectCurve;
    const applications = isRepeatable ? purchases : 1;

    for (
      let applicationLevel = 1;
      applicationLevel <= applications;
      applicationLevel += 1
    ) {
      const contextLevel = isRepeatable ? applicationLevel : purchases;
      const formulaContext = context.createFormulaEvaluationContext(
        contextLevel,
        context.step,
      );

      let effectCurveMultiplier = 1;
      if (effectCurve) {
        const multiplier = evaluateFiniteNumericFormula(
          effectCurve,
          formulaContext,
          context.onError,
          `Upgrade effect curve evaluation for "${record.definition.id}"`,
        );
        if (multiplier === undefined) {
          continue;
        }
        effectCurveMultiplier = multiplier;
      }

      for (const effect of record.definition.effects) {
        switch (effect.kind) {
          case 'modifyGeneratorRate': {
            const raw = evaluateFiniteNumericFormula(
              effect.value,
              formulaContext,
              context.onError,
              `Upgrade effect evaluation for "${record.definition.id}" (${effect.kind})`,
            );
            if (raw === undefined) {
              continue;
            }
            const effective = raw * effectCurveMultiplier;
            if (!Number.isFinite(effective)) {
              context.onError?.(
                new Error(
                  `Upgrade effect evaluation returned invalid effective value for "${record.definition.id}" (${effect.kind}): ${effective}`,
                ),
              );
              continue;
            }
            applyModifier(
              generatorRateMultipliers,
              effect.generatorId,
              effect.operation,
              effective,
              context.onError,
              `Generator rate modifier for "${record.definition.id}"`,
            );
            break;
          }
          case 'modifyGeneratorCost': {
            const raw = evaluateFiniteNumericFormula(
              effect.value,
              formulaContext,
              context.onError,
              `Upgrade effect evaluation for "${record.definition.id}" (${effect.kind})`,
            );
            if (raw === undefined) {
              continue;
            }
            const effective = raw * effectCurveMultiplier;
            if (!Number.isFinite(effective)) {
              context.onError?.(
                new Error(
                  `Upgrade effect evaluation returned invalid effective value for "${record.definition.id}" (${effect.kind}): ${effective}`,
                ),
              );
              continue;
            }
            applyModifier(
              generatorCostMultipliers,
              effect.generatorId,
              effect.operation,
              effective,
              context.onError,
              `Generator cost modifier for "${record.definition.id}"`,
            );
            break;
          }
          case 'modifyResourceRate': {
            const raw = evaluateFiniteNumericFormula(
              effect.value,
              formulaContext,
              context.onError,
              `Upgrade effect evaluation for "${record.definition.id}" (${effect.kind})`,
            );
            if (raw === undefined) {
              continue;
            }
            const effective = raw * effectCurveMultiplier;
            if (!Number.isFinite(effective)) {
              context.onError?.(
                new Error(
                  `Upgrade effect evaluation returned invalid effective value for "${record.definition.id}" (${effect.kind}): ${effective}`,
                ),
              );
              continue;
            }
            applyModifier(
              resourceRateMultipliers,
              effect.resourceId,
              effect.operation,
              effective,
              context.onError,
              `Resource rate modifier for "${record.definition.id}"`,
            );
            break;
          }
          case 'modifyResourceCapacity': {
            const raw = evaluateFiniteNumericFormula(
              effect.value,
              formulaContext,
              context.onError,
              `Upgrade effect evaluation for "${record.definition.id}" (${effect.kind})`,
            );
            if (raw === undefined) {
              continue;
            }
            const effective = raw * effectCurveMultiplier;
            if (!Number.isFinite(effective)) {
              context.onError?.(
                new Error(
                  `Upgrade effect evaluation returned invalid effective value for "${record.definition.id}" (${effect.kind}): ${effective}`,
                ),
              );
              continue;
            }
            applyCapacityOverride(
              resourceCapacityOverrides,
              context.getBaseCapacity,
              effect.resourceId,
              effect.operation,
              effective,
              context.onError,
              `Resource capacity modifier for "${record.definition.id}"`,
            );
            break;
          }
          case 'alterDirtyTolerance': {
            const raw = evaluateFiniteNumericFormula(
              effect.value,
              formulaContext,
              context.onError,
              `Upgrade effect evaluation for "${record.definition.id}" (${effect.kind})`,
            );
            if (raw === undefined) {
              continue;
            }
            const effective = raw * effectCurveMultiplier;
            if (!Number.isFinite(effective)) {
              context.onError?.(
                new Error(
                  `Upgrade effect evaluation returned invalid effective value for "${record.definition.id}" (${effect.kind}): ${effective}`,
                ),
              );
              continue;
            }
            applyDirtyToleranceOverride(
              dirtyToleranceOverrides,
              context.getBaseDirtyTolerance,
              effect.resourceId,
              effect.operation,
              effective,
              context.onError,
              `Dirty tolerance override for "${record.definition.id}"`,
            );
            break;
          }
          default:
            break;
        }
      }
    }
  }

  return Object.freeze({
    generatorRateMultipliers,
    generatorCostMultipliers,
    resourceRateMultipliers,
    resourceCapacityOverrides,
    dirtyToleranceOverrides,
    unlockedResources,
    unlockedGenerators,
    grantedAutomations,
    grantedFlags,
  });
}
