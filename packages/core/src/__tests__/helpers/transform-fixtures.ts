import type { ResourceStateAccessor } from '../../automation-system.js';
import type { ConditionContext } from '../../condition-evaluator.js';

export function createMockResourceState(
  resources: Map<string, { amount: number; capacity?: number }>,
): ResourceStateAccessor & { addAmount: (idx: number, amount: number) => number } {
  const indexById = new Map<string, number>();
  const amounts = new Map<number, number>();
  let idx = 0;

  for (const [id, { amount }] of resources) {
    indexById.set(id, idx);
    amounts.set(idx, amount);
    idx++;
  }

  return {
    getAmount: (index) => amounts.get(index) ?? 0,
    getResourceIndex: (id) => indexById.get(id) ?? -1,
    spendAmount: (index, amount, _context) => {
      const current = amounts.get(index) ?? 0;
      if (current < amount) return false;
      amounts.set(index, current - amount);
      return true;
    },
    addAmount: (index, amount) => {
      const current = amounts.get(index) ?? 0;
      amounts.set(index, current + amount);
      return amount;
    },
  };
}

export function createMockConditionContext(
  resources: Map<string, number>,
  generators?: Map<string, number>,
  upgrades?: Map<string, number>,
): ConditionContext {
  return {
    getResourceAmount: (id) => resources.get(id) ?? 0,
    getGeneratorLevel: (id) => generators?.get(id) ?? 0,
    getUpgradePurchases: (id) => upgrades?.get(id) ?? 0,
  };
}
