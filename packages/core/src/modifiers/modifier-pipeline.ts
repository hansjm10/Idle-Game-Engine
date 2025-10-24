export interface ModifierAccumulator {
  base: number;
  additive: number;
  multiplicative: number;
  exponential: number;
}

export type ModifierStage<TContext> = (
  context: TContext,
  accumulator: ModifierAccumulator,
) => void;

export interface ModifierPipeline<TContext> {
  readonly stages: readonly ModifierStage<TContext>[];
  apply(base: number, context: TContext): number;
}

const DEFAULT_MULTIPLIER = 1;
const DEFAULT_EXPONENT = 1;

/**
 * Create a deterministic modifier pipeline composed of pure stages.
 *
 * Stages operate on an accumulator so additive, multiplicative, and exponential
 * effects can be combined without retaining mutable state between evaluations.
 */
export function createModifierPipeline<TContext>(
  stages: readonly ModifierStage<TContext>[],
): ModifierPipeline<TContext> {
  const frozenStages = Object.freeze([...stages]);

  return Object.freeze({
    stages: frozenStages,
    apply(base: number, context: TContext): number {
      const accumulator: ModifierAccumulator = {
        base,
        additive: 0,
        multiplicative: DEFAULT_MULTIPLIER,
        exponential: DEFAULT_EXPONENT,
      };

      for (const stage of frozenStages) {
        stage(context, accumulator);
      }

      const linear = (accumulator.base + accumulator.additive) * accumulator.multiplicative;

      if (accumulator.exponential === DEFAULT_EXPONENT) {
        return linear;
      }

      const magnitude = Math.abs(linear) ** accumulator.exponential;
      return linear < 0 ? -magnitude : magnitude;
    },
  });
}

export function additiveModifier<TContext>(
  evaluate: (context: TContext) => number,
): ModifierStage<TContext> {
  return (context, accumulator) => {
    const contribution = evaluate(context);
    if (!Number.isFinite(contribution)) {
      throw new Error('additiveModifier produced a non-finite value.');
    }
    accumulator.additive += contribution;
  };
}

export function multiplicativeModifier<TContext>(
  evaluate: (context: TContext) => number,
): ModifierStage<TContext> {
  return (context, accumulator) => {
    const factor = evaluate(context);
    if (!Number.isFinite(factor)) {
      throw new Error('multiplicativeModifier produced a non-finite value.');
    }
    accumulator.multiplicative *= factor;
  };
}

export function exponentialModifier<TContext>(
  evaluate: (context: TContext) => number,
): ModifierStage<TContext> {
  return (context, accumulator) => {
    const exponent = evaluate(context);
    if (!Number.isFinite(exponent)) {
      throw new Error('exponentialModifier produced a non-finite value.');
    }
    accumulator.exponential *= exponent;
  };
}

export function clampModifier<TContext>(
  minimum: number,
  maximum: number,
): ModifierStage<TContext> {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new Error('clampModifier requires finite bounds.');
  }

  if (maximum < minimum) {
    throw new Error('clampModifier requires maximum >= minimum.');
  }

  return (_context, accumulator) => {
    const clamped = Math.min(
      Math.max(accumulator.base + accumulator.additive, minimum),
      maximum,
    );
    accumulator.base = clamped;
    accumulator.additive = 0;
  };
}

