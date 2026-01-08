import type { FormulaEvaluationContext } from '@idle-engine/content-schema';

/**
 * Shared helpers for building deterministic formula evaluation contexts.
 *
 * Progression formulas (costs, rates, thresholds, prestige rewards) need access
 * to time/level variables and current entity values. The facade owns the factory
 * implementation and passes it into managers so the formula wiring stays consistent.
 */
export type FormulaEvaluationContextOverrides = Readonly<{
  readonly generatorLevels?: Readonly<Record<string, number>>;
  readonly upgradePurchases?: Readonly<Record<string, number>>;
}>;

export type FormulaEvaluationContextFactory = (
  level: number,
  step: number,
  overrides?: FormulaEvaluationContextOverrides,
) => FormulaEvaluationContext;
