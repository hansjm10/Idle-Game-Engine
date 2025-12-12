import type { Condition, FormulaEvaluationContext } from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';

import { isDevelopmentMode } from './env-utils.js';

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

/**
 * Maximum allowed recursion depth for condition evaluation.
 *
 * @remarks
 * This prevents infinite recursion from circular condition dependencies.
 * Conditions exceeding this depth will return false and report an error.
 *
 * Value of 100 provides generous headroom for legitimately complex condition trees
 * (e.g., nested `allOf`/`anyOf` combinations) while catching circular dependencies
 * early enough to preserve stack space. In practice, well-designed content should
 * rarely exceed 10-20 levels. Deeply nested conditions (50+) likely indicate
 * content authoring issues or circular references.
 */
const MAX_CONDITION_DEPTH = 100;

/**
 * Context providing access to game state for condition evaluation
 */
export type ConditionContext = {
  readonly getResourceAmount: (resourceId: string) => number;
  readonly getGeneratorLevel: (generatorId: string) => number;
  readonly getUpgradePurchases: (upgradeId: string) => number;
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
  if (isDevelopmentMode()) {
    context.onError?.(error);
  } else {
    // eslint-disable-next-line no-console -- log degradation path in production builds
    console.warn(error.message);
  }
}

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
 * Conditions exceeding MAX_CONDITION_DEPTH will return false and report an error
 * to prevent infinite recursion from circular dependencies.
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

  // Check for excessive recursion depth (potential circular dependencies)
  if (depth > MAX_CONDITION_DEPTH) {
    const conditionInfo = condition ? ` (condition kind: "${condition.kind}")` : '';
    const error = new Error(
      `Condition evaluation exceeded maximum depth of ${MAX_CONDITION_DEPTH} at recursion level ${depth}${conditionInfo}. Possible circular dependency detected. Check for conditions that reference each other in a cycle.`,
    );
    if (isDevelopmentMode()) {
      context.onError?.(error);
    } else {
      // eslint-disable-next-line no-console -- Graceful degradation: log circular dependency warning in production
      console.warn(error.message);
    }
    return false;
  }

  switch (condition.kind) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'resourceThreshold': {
      const left = context.getResourceAmount(condition.resourceId);
      const formulaContext = createStaticFormulaEvaluationContext(context);
      const target = evaluateNumericFormula(condition.amount, {
        ...formulaContext,
      });
      return compareWithComparator(left, target, condition.comparator, context);
    }
    case 'generatorLevel': {
      const owned = context.getGeneratorLevel(condition.generatorId);
      const formulaContext = createStaticFormulaEvaluationContext(context);
      const required = evaluateNumericFormula(condition.level, {
        ...formulaContext,
      });
      return compareWithComparator(owned, required, condition.comparator, context);
    }
    case 'upgradeOwned': {
      const purchases = context.getUpgradePurchases(condition.upgradeId);
      return purchases >= condition.requiredPurchases;
    }
    case 'prestigeUnlocked': {
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
    }
    case 'flag': {
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
    }
    case 'script': {
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
    }
    case 'allOf':
      return condition.conditions.every((nested) =>
        evaluateCondition(nested, context, depth + 1),
      );
    case 'anyOf':
      return condition.conditions.some((nested) =>
        evaluateCondition(nested, context, depth + 1),
      );
    case 'not':
      return !evaluateCondition(condition.condition, context, depth + 1);
    default: {
      // Exhaustive check: if we reach here, TypeScript knows this should never happen
      const _exhaustive: never = condition;
      const error = new Error(
        `Unknown condition kind: ${(_exhaustive as Condition).kind}`,
      );
      if (isDevelopmentMode()) {
        context.onError?.(error);
      } else {
        // eslint-disable-next-line no-console -- Graceful degradation: log unknown condition types in production
        console.warn(error.message);
      }
      return false;
    }
  }
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
      const amount = evaluateNumericFormula(condition.amount, {
        variables: { level: STATIC_THRESHOLD_LEVEL },
      });
      return `Requires ${condition.resourceId} ${formatComparator(
        condition.comparator,
      )} ${formatNumber(amount)}`;
    }
    case 'generatorLevel': {
      const level = evaluateNumericFormula(condition.level, {
        variables: { level: STATIC_THRESHOLD_LEVEL },
      });
      return `Requires ${condition.generatorId} ${formatComparator(
        condition.comparator,
      )} ${formatNumber(level)}`;
    }
    case 'upgradeOwned':
      return `Requires owning ${condition.requiredPurchases}× ${condition.upgradeId}`;
    case 'allOf': {
      const parts = condition.conditions
        .map(describeCondition)
        .filter((value): value is string => Boolean(value));
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'anyOf': {
      const parts = condition.conditions
        .map(describeCondition)
        .filter((value): value is string => Boolean(value));
      return parts.length > 0
        ? `Requires any of: ${parts.join(' or ')}`
        : undefined;
    }
    case 'not': {
      const inner = describeCondition(condition.condition);
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
