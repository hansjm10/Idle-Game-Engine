import { z } from 'zod';

/**
 * Placeholder number-related schemas. To be refined with numeric constraints later.
 */
export const finiteNumberSchema = z.number();
export const nonNegativeNumberSchema = z.number();
export const integerSchema = z.number();
