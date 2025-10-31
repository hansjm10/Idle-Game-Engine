import type { Condition, NumericFormula } from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';

/**
 * Context providing access to game state for condition evaluation
 */
export type ConditionContext = {
  readonly getResourceAmount: (resourceId: string) => number;
  readonly getGeneratorLevel: (generatorId: string) => number;
  readonly getUpgradePurchases: (upgradeId: string) => number;
};

/**
 * Evaluates a condition against the current game state
 *
 * @param condition - The condition to evaluate, or undefined (which evaluates to true)
 * @param context - Context providing access to game state
 * @returns true if the condition is met, false otherwise
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
): boolean {
  if (!condition) {
    return true;
  }

  switch (condition.kind) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'resourceThreshold': {
      const left = context.getResourceAmount(condition.resourceId);
      const target = evaluateNumericFormula(condition.amount, {
        variables: { level: 0 },
      });
      return compareWithComparator(left, target, condition.comparator);
    }
    case 'generatorLevel': {
      const owned = context.getGeneratorLevel(condition.generatorId);
      const required = evaluateNumericFormula(condition.level, {
        variables: { level: 0 },
      });
      return compareWithComparator(owned, required, condition.comparator);
    }
    case 'upgradeOwned': {
      const purchases = context.getUpgradePurchases(condition.upgradeId);
      return purchases >= condition.requiredPurchases;
    }
    case 'allOf':
      return condition.conditions.every((nested) =>
        evaluateCondition(nested, context),
      );
    case 'anyOf':
      return condition.conditions.some((nested) =>
        evaluateCondition(nested, context),
      );
    case 'not':
      return !evaluateCondition(condition.condition, context);
    default:
      return false;
  }
}

/**
 * Compares two numeric values using a comparator
 *
 * @param left - Left operand
 * @param right - Right operand
 * @param comparator - Comparison operator
 * @returns true if the comparison holds, false otherwise
 */
export function compareWithComparator(
  left: number,
  right: number,
  comparator: 'gte' | 'gt' | 'lte' | 'lt',
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
    default:
      return false;
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
        variables: { level: 0 },
      });
      return `Requires ${condition.resourceId} ${formatComparator(
        condition.comparator,
      )} ${formatNumber(amount)}`;
    }
    case 'generatorLevel': {
      const level = evaluateNumericFormula(condition.level, {
        variables: { level: 0 },
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
