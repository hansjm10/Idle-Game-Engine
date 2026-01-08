import type { FormulaEvaluationContext } from '@idle-engine/content-schema';

export type FormulaEvaluationContextOverrides = Readonly<{
  readonly generatorLevels?: Readonly<Record<string, number>>;
  readonly upgradePurchases?: Readonly<Record<string, number>>;
}>;

export type FormulaEvaluationContextFactory = (
  level: number,
  step: number,
  overrides?: FormulaEvaluationContextOverrides,
) => FormulaEvaluationContext;

