export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export const isNonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';
