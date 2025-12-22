export const toMutablePath = (
  path: readonly (string | number)[],
): (string | number)[] => [...path];
