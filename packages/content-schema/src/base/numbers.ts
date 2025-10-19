import { z } from 'zod';

const FINITE_NUMBER_MESSAGE = 'Value must be a finite number.';
const NONNEGATIVE_NUMBER_MESSAGE = 'Value must be greater than or equal to 0.';
const POSITIVE_INTEGER_MESSAGE =
  'Value must be a positive integer greater than 0.';
const PERCENTAGE_RANGE_MESSAGE = 'Value must be between 0 and 1 inclusive.';

const ensureFinite = (value: number, ctx: z.RefinementCtx) => {
  if (!Number.isFinite(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: FINITE_NUMBER_MESSAGE,
    });
    return z.NEVER;
  }

  return value;
};

export const finiteNumberSchema = z.coerce
  .number()
  .transform((value, ctx) => ensureFinite(value, ctx));

export const nonnegativeNumberSchema = finiteNumberSchema.refine(
  (value) => value >= 0,
  {
    message: NONNEGATIVE_NUMBER_MESSAGE,
  },
);

export const positiveIntSchema = z.coerce
  .number()
  .transform((value, ctx) => ensureFinite(value, ctx))
  .refine(Number.isInteger, {
    message: POSITIVE_INTEGER_MESSAGE,
  })
  .refine((value) => value > 0, {
    message: POSITIVE_INTEGER_MESSAGE,
  });

export const percentSchema = finiteNumberSchema.refine(
  (value) => value >= 0 && value <= 1,
  {
    message: PERCENTAGE_RANGE_MESSAGE,
  },
);

export const integerSchema = finiteNumberSchema.refine(Number.isInteger, {
  message: 'Value must be an integer.',
});
