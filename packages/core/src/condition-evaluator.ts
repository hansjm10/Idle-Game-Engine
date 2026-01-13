import type { Condition, FormulaEvaluationContext } from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';

import { isDevelopmentMode } from './env-utils.js';
import { DEFAULT_ENGINE_CONFIG } from './config.js';

/**
 * Level value used for evaluating static unlock thresholds.
 *
 * @remarks
 * Unlock conditions use constant thresholds that don't scale with progression,
 * unlike dynamic cost curves that increase with level. This constant makes the
 * intent explicit when evaluating formulas for unlock/visibility checks.
 *
 * Value is 0 because unlock thresholds represent absolute gates (e.g., "unlock when
 * you have 100 energy") rather than scaling requirements. Using 0 ensures formulas
 * like `{ kind: 'constant', value: 100 }` evaluate to their base value without
 * level-based scaling.
 */
const STATIC_THRESHOLD_LEVEL = 0;

const DEFAULT_MAX_CONDITION_DEPTH = DEFAULT_ENGINE_CONFIG.limits.maxConditionDepth;

/**
 * Context providing access to game state for condition evaluation
 */
export type ConditionContext = {
  readonly getResourceAmount: (resourceId: string) => number;
  readonly getGeneratorLevel: (generatorId: string) => number;
  readonly getUpgradePurchases: (upgradeId: string) => number;
  /**
   * Optional override for the recursion guard used by {@link evaluateCondition}.
   *
   * @defaultValue `100` (see {@link DEFAULT_ENGINE_CONFIG})
   */
  readonly maxConditionDepth?: number;
  /**
   * Optional hook indicating whether a prestige layer is unlocked.
   */
  readonly hasPrestigeLayerUnlocked?: (prestigeLayerId: string) => boolean;
  /**
   * Optional hook for feature flag checks.
   */
  readonly isFlagSet?: (flagId: string) => boolean;
  /**
   * Optional hook for evaluating script-driven conditions.
   */
  readonly evaluateScriptCondition?: (scriptId: string) => boolean;
  /**
   * Optional callback for reporting errors encountered during evaluation.
   * Called when unknown condition kinds or comparators are encountered.
   */
  readonly onError?: (error: Error) => void;
  /**
   * Optional hooks for resolving display names in condition descriptions.
   */
  readonly resolveResourceName?: (resourceId: string) => string | undefined;
  readonly resolveGeneratorName?: (generatorId: string) => string | undefined;
  readonly resolveUpgradeName?: (upgradeId: string) => string | undefined;
  readonly resolvePrestigeLayerName?: (
    prestigeLayerId: string,
  ) => string | undefined;
};

const createStaticFormulaEvaluationContext = (
  context: ConditionContext,
): FormulaEvaluationContext => ({
  variables: {
    level: STATIC_THRESHOLD_LEVEL,
    time: 0,
    deltaTime: 0,
  },
  entities: {
    resource: (resourceId) => context.getResourceAmount(resourceId),
    generator: (generatorId) => context.getGeneratorLevel(generatorId),
    upgrade: (upgradeId) => context.getUpgradePurchases(upgradeId),
  },
});

const DEFAULT_DESCRIPTION_FORMULA_CONTEXT: FormulaEvaluationContext = {
  variables: {
    level: STATIC_THRESHOLD_LEVEL,
    time: 0,
    deltaTime: 0,
  },
  entities: {
    resource: () => 0,
    generator: () => 0,
    upgrade: () => 0,
    automation: () => 0,
    prestigeLayer: () => 0,
  },
};

const createDescriptionFormulaEvaluationContext = (
  context: ConditionContext | undefined,
): FormulaEvaluationContext => {
  if (!context) {
    return DEFAULT_DESCRIPTION_FORMULA_CONTEXT;
  }

  return {
    variables: DEFAULT_DESCRIPTION_FORMULA_CONTEXT.variables,
    entities: {
      ...DEFAULT_DESCRIPTION_FORMULA_CONTEXT.entities,
      resource: (resourceId) => context.getResourceAmount(resourceId),
      generator: (generatorId) => context.getGeneratorLevel(generatorId),
      upgrade: (upgradeId) => context.getUpgradePurchases(upgradeId),
    },
  };
};

const isConditionSatisfied = (
  condition: Condition,
  context: ConditionContext,
): boolean => {
  try {
    return evaluateCondition(condition, context);
  } catch {
    return false;
  }
};

const resolveDisplayName = (
  resolver: ((id: string) => string | undefined) | undefined,
  fallbackId: string,
): string => {
  if (!resolver) {
    return fallbackId;
  }
  const resolved = resolver(fallbackId);
  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    return fallbackId;
  }
  return resolved;
};

function reportConditionEvaluationError(
  context: Pick<ConditionContext, 'onError'>,
  error: Error,
): void {
  if (isDevelopmentMode()) {
    context.onError?.(error);
    return;
  }
  // eslint-disable-next-line no-console -- graceful degradation path in production builds
  console.warn(error.message);
}

function reportMissingContextHook(
  context: ConditionContext,
  hook: keyof ConditionContext,
  conditionKind: Condition['kind'],
  targetId: string,
): void {
  const error = new Error(
    `Condition "${conditionKind}" targeting "${targetId}" requires ConditionContext.${String(
      hook,
    )}()`,
  );
  reportConditionEvaluationError(context, error);
}

type ConditionEvaluator<K extends Condition['kind']> = (
  condition: Extract<Condition, { kind: K }>,
  context: ConditionContext,
  depth: number,
) => boolean;

const CONDITION_EVALUATORS = {
  always: (_condition, _context, _depth) => true,
  never: (_condition, _context, _depth) => false,
  resourceThreshold: (condition, context) => {
    const left = context.getResourceAmount(condition.resourceId);
    const formulaContext = createStaticFormulaEvaluationContext(context);
    const target = evaluateNumericFormula(condition.amount, {
      ...formulaContext,
    });
    return compareWithComparator(left, target, condition.comparator, context);
  },
  generatorLevel: (condition, context) => {
    const owned = context.getGeneratorLevel(condition.generatorId);
    const formulaContext = createStaticFormulaEvaluationContext(context);
    const required = evaluateNumericFormula(condition.level, {
      ...formulaContext,
    });
    return compareWithComparator(owned, required, condition.comparator, context);
  },
  upgradeOwned: (condition, context) => {
    const purchases = context.getUpgradePurchases(condition.upgradeId);
    return purchases >= condition.requiredPurchases;
  },
  prestigeCountThreshold: (condition, context) => {
    const prestigeCountId = `${condition.prestigeLayerId}-prestige-count`;
    const count = context.getResourceAmount(prestigeCountId);
    return compareWithComparator(count, condition.count, condition.comparator, context);
  },
  prestigeCompleted: (condition, context) => {
    const prestigeCountId = `${condition.prestigeLayerId}-prestige-count`;
    const count = context.getResourceAmount(prestigeCountId);
    return count >= 1;
  },
  prestigeUnlocked: (condition, context) => {
    if (!context.hasPrestigeLayerUnlocked) {
      reportMissingContextHook(
        context,
        'hasPrestigeLayerUnlocked',
        condition.kind,
        condition.prestigeLayerId,
      );
      return false;
    }
    return context.hasPrestigeLayerUnlocked(condition.prestigeLayerId);
  },
  flag: (condition, context) => {
    if (!context.isFlagSet) {
      reportMissingContextHook(
        context,
        'isFlagSet',
        condition.kind,
        condition.flagId,
      );
      return false;
    }
    return context.isFlagSet(condition.flagId);
  },
  script: (condition, context) => {
    if (!context.evaluateScriptCondition) {
      reportMissingContextHook(
        context,
        'evaluateScriptCondition',
        condition.kind,
        condition.scriptId,
      );
      return false;
    }
    return context.evaluateScriptCondition(condition.scriptId);
  },
  allOf: (condition, context, depth) =>
    condition.conditions.every((nested) =>
      evaluateCondition(nested, context, depth + 1),
    ),
  anyOf: (condition, context, depth) =>
    condition.conditions.some((nested) =>
      evaluateCondition(nested, context, depth + 1),
    ),
  not: (condition, context, depth) =>
    !evaluateCondition(condition.condition, context, depth + 1),
} satisfies { [K in Condition['kind']]: ConditionEvaluator<K> };

/**
 * Evaluates a condition against the current game state
 *
 * @param condition - The condition to evaluate, or undefined (which evaluates to true)
 * @param context - Context providing access to game state
 * @param depth - Internal recursion depth tracker (defaults to 0)
 * @returns true if the condition is met, false otherwise
 *
 * @remarks
 * Unknown condition kinds will return false as a fail-safe default.
 * This ensures graceful degradation if the schema contains unrecognized condition types.
 *
 * Conditions exceeding the configured maximum depth will return false and report
 * an error to prevent infinite recursion from circular dependencies.
 *
 * @example
 * ```typescript
 * const context = {
 *   getResourceAmount: (id) => resourceState.getAmount(id),
 *   getGeneratorLevel: (id) => generatorState.getOwned(id),
 *   getUpgradePurchases: (id) => upgradeState.getPurchases(id),
 * };
 *
 * const unlocked = evaluateCondition(generator.baseUnlock, context);
 * ```
 */
export function evaluateCondition(
  condition: Condition | undefined,
  context: ConditionContext,
  depth = 0,
): boolean {
  if (!condition) {
    return true;
  }

  const configuredMaxDepth = context.maxConditionDepth;
  const maxDepth =
    typeof configuredMaxDepth === 'number' &&
    Number.isFinite(configuredMaxDepth) &&
    configuredMaxDepth > 0
      ? Math.floor(configuredMaxDepth)
      : DEFAULT_MAX_CONDITION_DEPTH;

  // Check for excessive recursion depth (potential circular dependencies)
  if (depth > maxDepth) {
    const conditionInfo = condition ? ` (condition kind: "${condition.kind}")` : '';
    const error = new Error(
      `Condition evaluation exceeded maximum depth of ${maxDepth} at recursion level ${depth}${conditionInfo}. Possible circular dependency detected. Check for conditions that reference each other in a cycle.`,
    );
    reportConditionEvaluationError(context, error);
    return false;
  }

  const evaluator = (CONDITION_EVALUATORS as Record<
    string,
    (condition: Condition, context: ConditionContext, depth: number) => boolean
  >)[condition.kind];

  if (typeof evaluator !== 'function') {
    reportConditionEvaluationError(
      context,
      new Error(`Unknown condition kind: ${condition.kind}`),
    );
    return false;
  }

  return evaluator(condition, context, depth);
}

/**
 * Compares two numeric values using a comparator
 *
 * @param left - Left operand
 * @param right - Right operand
 * @param comparator - Comparison operator
 * @param context - Optional context for error reporting
 * @returns true if the comparison holds, false otherwise
 *
 * @remarks
 * Unknown comparators return false as a fail-safe default.
 */
export function compareWithComparator(
  left: number,
  right: number,
  comparator: 'gte' | 'gt' | 'lte' | 'lt',
  context?: Pick<ConditionContext, 'onError'>,
): boolean {
  switch (comparator) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    default: {
      // Exhaustive check: if we reach here, TypeScript knows this should never happen
      const _exhaustive: never = comparator;
      const error = new Error(`Unknown comparator: ${_exhaustive}`);
      if (isDevelopmentMode()) {
        context?.onError?.(error);
      } else {
        // eslint-disable-next-line no-console -- Graceful degradation: log unknown comparators in production
        console.warn(error.message);
      }
      return false;
    }
  }
}

/**
 * Combines multiple conditions into a single 'allOf' condition
 *
 * @param conditions - Array of conditions to combine
 * @returns A single condition representing all conditions, or undefined if empty
 *
 * @example
 * ```typescript
 * const combined = combineConditions([condition1, condition2, condition3]);
 * // Returns: { kind: 'allOf', conditions: [condition1, condition2, condition3] }
 * ```
 */
export function combineConditions(
  conditions: readonly Condition[],
): Condition | undefined {
  if (conditions.length === 0) {
    return undefined;
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return {
    kind: 'allOf',
    conditions: [...conditions],
  };
}

/**
 * Generates a human-readable description of a condition
 *
 * @param condition - The condition to describe
 * @returns A human-readable string describing the condition, or undefined if no description is needed
 *
 * @example
 * ```typescript
 * const hint = describeCondition(upgrade.unlockCondition);
 * // Returns: "Requires resource.energy >= 100"
 * ```
 */
export function describeCondition(
  condition: Condition | undefined,
  context?: ConditionContext,
): string | undefined {
  if (!condition) {
    return undefined;
  }

  switch (condition.kind) {
    case 'always':
      return undefined;
    case 'never':
      return 'Unavailable in this build';
    case 'resourceThreshold': {
      const formulaContext = createDescriptionFormulaEvaluationContext(context);
      const amount = evaluateNumericFormula(condition.amount, {
        ...formulaContext,
      });
      const resourceName = resolveDisplayName(
        context?.resolveResourceName,
        condition.resourceId,
      );
      return `Requires ${resourceName} ${formatComparator(
        condition.comparator,
      )} ${formatNumber(amount)}`;
    }
    case 'generatorLevel': {
      const formulaContext = createDescriptionFormulaEvaluationContext(context);
      const level = evaluateNumericFormula(condition.level, {
        ...formulaContext,
      });
      const generatorName = resolveDisplayName(
        context?.resolveGeneratorName,
        condition.generatorId,
      );
      return `Requires ${generatorName} ${formatComparator(
        condition.comparator,
      )} ${formatNumber(level)}`;
    }
    case 'upgradeOwned':
      return `Requires owning ${condition.requiredPurchases}× ${resolveDisplayName(
        context?.resolveUpgradeName,
        condition.upgradeId,
      )}`;
    case 'prestigeCountThreshold':
      return `Requires prestige count for ${resolveDisplayName(
        context?.resolvePrestigeLayerName,
        condition.prestigeLayerId,
      )} ${formatComparator(condition.comparator)} ${formatNumber(condition.count)}`;
    case 'prestigeCompleted':
      return `Requires prestiged at least once in ${resolveDisplayName(
        context?.resolvePrestigeLayerName,
        condition.prestigeLayerId,
      )}`;
    case 'prestigeUnlocked':
      return `Requires prestige layer ${resolveDisplayName(
        context?.resolvePrestigeLayerName,
        condition.prestigeLayerId,
      )} available`;
    case 'allOf': {
      const pendingConditions =
        context
          ? condition.conditions.filter(
              (nested) => !isConditionSatisfied(nested, context),
            )
          : condition.conditions;
      if (pendingConditions.length === 0) {
        return undefined;
      }

      const parts = pendingConditions
        .map((nested) => describeCondition(nested, context))
        .filter((value): value is string => Boolean(value));
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'anyOf': {
      if (
        context &&
        condition.conditions.some((nested) => isConditionSatisfied(nested, context))
      ) {
        return undefined;
      }

      const parts = condition.conditions
        .map((nested) => describeCondition(nested, context))
        .filter((value): value is string => Boolean(value));
      return parts.length > 0
        ? `Requires any of: ${parts.join(' or ')}`
        : undefined;
    }
    case 'not': {
      const inner = describeCondition(condition.condition, context);
      return inner ? `Not (${inner})` : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Formats a comparator as a human-readable symbol
 *
 * @param comparator - The comparator to format
 * @returns A symbol representation of the comparator
 */
export function formatComparator(comparator: 'gte' | 'gt' | 'lte' | 'lt'): string {
  switch (comparator) {
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
    default:
      return comparator;
  }
}

/**
 * Formats a number as a human-readable string
 *
 * @param value - The number to format
 * @returns A formatted string representation
 *
 * @example
 * ```typescript
 * formatNumber(100) // "100"
 * formatNumber(100.00) // "100"
 * formatNumber(0.01) // "0.010"
 * ```
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return 'Infinity';
  }
  if (Math.abs(value) >= 1 || value === 0) {
    return value.toFixed(2).replace(/\.00$/, '');
  }
  return value.toPrecision(2);
}
