import type { NumericFormula } from '@idle-engine/content-schema';

export function literal(value: number): NumericFormula {
  return { kind: 'constant', value };
}
