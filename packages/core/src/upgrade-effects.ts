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
  readonly generatorConsumptionMultipliers: ReadonlyMap<string, number>;
  readonly generatorResourceConsumptionMultipliers: ReadonlyMap<
    string,
    ReadonlyMap<string, number>
  >;
  readonly resourceRateMultipliers: ReadonlyMap<string, number>;
  readonly resourceCapacityOverrides: ReadonlyMap<string, number>;
  readonly dirtyToleranceOverrides: ReadonlyMap<string, number>;
  readonly unlockedResources: ReadonlySet<string>;
  readonly unlockedGenerators: ReadonlySet<string>;
  readonly grantedAutomations: ReadonlySet<string>;
  readonly grantedFlags: ReadonlyMap<string, boolean>;
}>;

type AdjustmentOperation = 'add' | 'multiply' | 'set';

type UpgradeEffectDefinition = UpgradeEffectSource['definition']['effects'][number];

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

function getGeneratorResourceConsumptionMultipliers(
  multipliers: Map<string, Map<string, number>>,
  generatorId: string,
): Map<string, number> {
  const existing = multipliers.get(generatorId);
  if (existing) {
    return existing;
  }
  const created = new Map<string, number>();
  multipliers.set(generatorId, created);
  return created;
}

function collectUnlockedEffects(
  effects: readonly UpgradeEffectDefinition[],
  unlockedResources: Set<string>,
  unlockedGenerators: Set<string>,
  grantedAutomations: Set<string>,
  grantedFlags: Map<string, boolean>,
): void {
  for (const effect of effects) {
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
}

function resolveUpgradeApplicationCount(record: UpgradeEffectSource): {
  purchases: number;
  applications: number;
  effectCurve: NumericFormula | undefined;
  isRepeatable: boolean;
} {
  const purchases = record.purchases;
  const repeatableConfig = record.definition.repeatable;
  const isRepeatable = repeatableConfig !== undefined;
  return {
    purchases,
    applications: isRepeatable ? purchases : 1,
    effectCurve: repeatableConfig?.effectCurve,
    isRepeatable,
  };
}

function resolveEffectCurveMultiplier(
  effectCurve: NumericFormula | undefined,
  formulaContext: FormulaEvaluationContext,
  onError: ((error: Error) => void) | undefined,
  upgradeId: string,
): number | undefined {
  if (!effectCurve) {
    return 1;
  }

  return evaluateFiniteNumericFormula(
    effectCurve,
    formulaContext,
    onError,
    `Upgrade effect curve evaluation for "${upgradeId}"`,
  );
}

function resolveEffectiveUpgradeEffectValue(
  effect: Extract<
    UpgradeEffectDefinition,
    {
      kind:
        | 'modifyGeneratorRate'
        | 'modifyGeneratorCost'
        | 'modifyGeneratorConsumption'
        | 'modifyResourceRate'
        | 'modifyResourceCapacity'
        | 'alterDirtyTolerance';
    }
  >,
  formulaContext: FormulaEvaluationContext,
  effectCurveMultiplier: number,
  onError: ((error: Error) => void) | undefined,
  upgradeId: string,
): number | undefined {
  const raw = evaluateFiniteNumericFormula(
    effect.value,
    formulaContext,
    onError,
    `Upgrade effect evaluation for "${upgradeId}" (${effect.kind})`,
  );
  if (raw === undefined) {
    return undefined;
  }

  const effective = raw * effectCurveMultiplier;
  if (!Number.isFinite(effective)) {
    onError?.(
      new Error(
        `Upgrade effect evaluation returned invalid effective value for "${upgradeId}" (${effect.kind}): ${effective}`,
      ),
    );
    return undefined;
  }

  return effective;
}

function applyUpgradeEffectValue(
  effect: UpgradeEffectDefinition,
  upgradeId: string,
  formulaContext: FormulaEvaluationContext,
  effectCurveMultiplier: number,
  context: UpgradeEffectEvaluatorContext,
  output: Readonly<{
    generatorRateMultipliers: Map<string, number>;
    generatorCostMultipliers: Map<string, number>;
    generatorConsumptionMultipliers: Map<string, number>;
    generatorResourceConsumptionMultipliers: Map<string, Map<string, number>>;
    resourceRateMultipliers: Map<string, number>;
    resourceCapacityOverrides: Map<string, number>;
    dirtyToleranceOverrides: Map<string, number>;
  }>,
): void {
  switch (effect.kind) {
    case 'modifyGeneratorRate': {
      const effective = resolveEffectiveUpgradeEffectValue(
        effect,
        formulaContext,
        effectCurveMultiplier,
        context.onError,
        upgradeId,
      );
      if (effective === undefined) {
        return;
      }
      applyModifier(
        output.generatorRateMultipliers,
        effect.generatorId,
        effect.operation,
        effective,
        context.onError,
        `Generator rate modifier for "${upgradeId}"`,
      );
      return;
    }
    case 'modifyGeneratorCost': {
      const effective = resolveEffectiveUpgradeEffectValue(
        effect,
        formulaContext,
        effectCurveMultiplier,
        context.onError,
        upgradeId,
      );
      if (effective === undefined) {
        return;
      }
      applyModifier(
        output.generatorCostMultipliers,
        effect.generatorId,
        effect.operation,
        effective,
        context.onError,
        `Generator cost modifier for "${upgradeId}"`,
      );
      return;
    }
    case 'modifyGeneratorConsumption': {
      const effective = resolveEffectiveUpgradeEffectValue(
        effect,
        formulaContext,
        effectCurveMultiplier,
        context.onError,
        upgradeId,
      );
      if (effective === undefined) {
        return;
      }
      if (effect.resourceId) {
        const resourceMultipliers = getGeneratorResourceConsumptionMultipliers(
          output.generatorResourceConsumptionMultipliers,
          effect.generatorId,
        );
        applyModifier(
          resourceMultipliers,
          effect.resourceId,
          effect.operation,
          effective,
          context.onError,
          `Generator consumption modifier for "${upgradeId}"`,
        );
        return;
      }
      applyModifier(
        output.generatorConsumptionMultipliers,
        effect.generatorId,
        effect.operation,
        effective,
        context.onError,
        `Generator consumption modifier for "${upgradeId}"`,
      );
      return;
    }
    case 'modifyResourceRate': {
      const effective = resolveEffectiveUpgradeEffectValue(
        effect,
        formulaContext,
        effectCurveMultiplier,
        context.onError,
        upgradeId,
      );
      if (effective === undefined) {
        return;
      }
      applyModifier(
        output.resourceRateMultipliers,
        effect.resourceId,
        effect.operation,
        effective,
        context.onError,
        `Resource rate modifier for "${upgradeId}"`,
      );
      return;
    }
    case 'modifyResourceCapacity': {
      const effective = resolveEffectiveUpgradeEffectValue(
        effect,
        formulaContext,
        effectCurveMultiplier,
        context.onError,
        upgradeId,
      );
      if (effective === undefined) {
        return;
      }
      applyCapacityOverride(
        output.resourceCapacityOverrides,
        context.getBaseCapacity,
        effect.resourceId,
        effect.operation,
        effective,
        context.onError,
        `Resource capacity modifier for "${upgradeId}"`,
      );
      return;
    }
    case 'alterDirtyTolerance': {
      const effective = resolveEffectiveUpgradeEffectValue(
        effect,
        formulaContext,
        effectCurveMultiplier,
        context.onError,
        upgradeId,
      );
      if (effective === undefined) {
        return;
      }
      applyDirtyToleranceOverride(
        output.dirtyToleranceOverrides,
        context.getBaseDirtyTolerance,
        effect.resourceId,
        effect.operation,
        effective,
        context.onError,
        `Dirty tolerance override for "${upgradeId}"`,
      );
      return;
    }
    default:
      return;
  }
}

function applyUpgradeRecordEffects(
  record: UpgradeEffectSource,
  context: UpgradeEffectEvaluatorContext,
  output: Readonly<{
    generatorRateMultipliers: Map<string, number>;
    generatorCostMultipliers: Map<string, number>;
    generatorConsumptionMultipliers: Map<string, number>;
    generatorResourceConsumptionMultipliers: Map<string, Map<string, number>>;
    resourceRateMultipliers: Map<string, number>;
    resourceCapacityOverrides: Map<string, number>;
    dirtyToleranceOverrides: Map<string, number>;
  }>,
): void {
  const { purchases, applications, effectCurve, isRepeatable } =
    resolveUpgradeApplicationCount(record);

  for (let applicationIndex = 0; applicationIndex < applications; applicationIndex += 1) {
    const applicationLevel = applicationIndex + 1;
    const contextLevel = isRepeatable ? applicationLevel : purchases;
    const formulaContext = context.createFormulaEvaluationContext(
      contextLevel,
      context.step,
    );

    const effectCurveMultiplier = resolveEffectCurveMultiplier(
      effectCurve,
      formulaContext,
      context.onError,
      record.definition.id,
    );
    if (effectCurveMultiplier === undefined) {
      continue;
    }

    for (const effect of record.definition.effects) {
      applyUpgradeEffectValue(
        effect,
        record.definition.id,
        formulaContext,
        effectCurveMultiplier,
        context,
        output,
      );
    }
  }
}

export function evaluateUpgradeEffects(
  upgrades: readonly UpgradeEffectSource[],
  context: UpgradeEffectEvaluatorContext,
): EvaluatedUpgradeEffects {
  const generatorRateMultipliers = new Map<string, number>();
  const generatorCostMultipliers = new Map<string, number>();
  const generatorConsumptionMultipliers = new Map<string, number>();
  const generatorResourceConsumptionMultipliers = new Map<
    string,
    Map<string, number>
  >();
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

    collectUnlockedEffects(
      record.definition.effects,
      unlockedResources,
      unlockedGenerators,
      grantedAutomations,
      grantedFlags,
    );

    applyUpgradeRecordEffects(record, context, {
      generatorRateMultipliers,
      generatorCostMultipliers,
      generatorConsumptionMultipliers,
      generatorResourceConsumptionMultipliers,
      resourceRateMultipliers,
      resourceCapacityOverrides,
      dirtyToleranceOverrides,
    });
  }

  return Object.freeze({
    generatorRateMultipliers,
    generatorCostMultipliers,
    generatorConsumptionMultipliers,
    generatorResourceConsumptionMultipliers,
    resourceRateMultipliers,
    resourceCapacityOverrides,
    dirtyToleranceOverrides,
    unlockedResources,
    unlockedGenerators,
    grantedAutomations,
    grantedFlags,
  });
}
