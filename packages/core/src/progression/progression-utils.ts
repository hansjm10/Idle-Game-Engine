import type { NumericFormula } from '@idle-engine/content-schema';
import {
  evaluateNumericFormula,
  type FormulaEvaluationContext,
} from '@idle-engine/content-schema';

/**
 * Small shared utilities used by progression managers.
 *
 * Kept separate from the facade/managers to avoid incidental import cycles and
 * to centralize common numeric sanitization (finite/non-negative checks) and
 * display-name normalization for content-localized fields.
 */
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

export function evaluateCostFormula(
  formula: NumericFormula,
  context: FormulaEvaluationContext,
): number | undefined {
  try {
    const amount = evaluateNumericFormula(formula, context);
    return Number.isFinite(amount) ? amount : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateFiniteNumericFormula(
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

export function normalizeFiniteNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

export function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

export function normalizeOptionalNonNegativeInt(
  value: unknown,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function clampOwned(owned: number, maxLevel?: number): number {
  const normalizedOwned = Number.isFinite(owned) ? owned : 0;
  if (maxLevel === undefined) {
    return Math.max(0, normalizedOwned);
  }
  const upperBound = Math.max(0, maxLevel);
  return Math.max(0, Math.min(normalizedOwned, upperBound));
}

export function getDisplayName(name: unknown, fallback: string): string {
  if (typeof name === 'string') {
    return name;
  }
  if (name && typeof name === 'object') {
    const record = name as { readonly default?: unknown };
    if (typeof record.default === 'string') {
      return record.default;
    }
  }
  return fallback;
}
