import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateNumericFormula,
  createDeterministicFormulaEvaluationContext,
  type NormalizedGenerator,
  type NormalizedUpgrade,
  type NormalizedResource,
  type NormalizedAutomation,
  type NormalizedPrestigeLayer,
  type FormulaEvaluationEntities,
} from '@idle-engine/content-schema';

// Note: buildProgressionSnapshot is not exported from the core index; import relatively.
import { buildProgressionSnapshot } from '../../core/src/progression.js';
import type {
  ProgressionAuthoritativeState,
  GeneratorPurchaseEvaluator,
  GeneratorPurchaseQuote,
  UpgradePurchaseEvaluator,
  UpgradePurchaseQuote,
} from '../../core/src/resource-command-handlers.js';

import { sampleContent } from '.';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, '__fixtures__', 'progression.snapshot.golden.json');

const toDisplayName = (name: { readonly default: string }) => name.default;

const evaluateCost = (
  curve: unknown,
  level: number,
  costMultiplier: number,
  entities: FormulaEvaluationEntities,
): number => {
  const multiplier = evaluateNumericFormula(curve as any, {
    variables: { level, time: 0, deltaTime: 1 },
    entities,
  });
  const amount = costMultiplier * multiplier;
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
};

const createGeneratorEvaluator = (
  generators: readonly NormalizedGenerator[],
  entities: FormulaEvaluationEntities,
): GeneratorPurchaseEvaluator => {
  const byId = new Map(generators.map((g) => [g.id, g] as const));
  return {
    getPurchaseQuote(generatorId: string, count: number): GeneratorPurchaseQuote | undefined {
      if (count !== 1) return undefined;
      const gen = byId.get(generatorId);
      if (!gen) return undefined;

      if ('costs' in gen.purchase) {
        const costs = gen.purchase.costs.map((cost) => ({
          resourceId: cost.resourceId,
          amount: evaluateCost(cost.costCurve, 0, cost.costMultiplier, entities),
        }));
        return {
          generatorId,
          costs,
        };
      }

      const amount = evaluateCost(gen.purchase.costCurve, 0, gen.purchase.costMultiplier, entities);
      return {
        generatorId,
        costs: [{ resourceId: gen.purchase.currencyId, amount }],
      };
    },
    applyPurchase() {
      // no-op for snapshot test
    },
  };
};

const createUpgradeEvaluator = (
  upgrades: readonly NormalizedUpgrade[],
  entities: FormulaEvaluationEntities,
): UpgradePurchaseEvaluator => {
  const byId = new Map(upgrades.map((u) => [u.id, u] as const));
  return {
    getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined {
      const up = byId.get(upgradeId);
      if (!up) return undefined;

      if ('costs' in up.cost) {
        const costs = up.cost.costs.map((cost) => ({
          resourceId: cost.resourceId,
          amount: evaluateCost(cost.costCurve, 0, cost.costMultiplier, entities),
        }));
        return {
          upgradeId,
          status: 'available',
          costs,
        };
      }

      const amount = evaluateCost(up.cost.costCurve, 0, up.cost.costMultiplier, entities);
      return {
        upgradeId,
        status: 'available',
        costs: [{ resourceId: up.cost.currencyId, amount }],
      };
    },
    applyPurchase() {
      // no-op for snapshot test
    },
  };
};

describe('sample content progression snapshot (golden)', () => {
  it('matches golden generator and upgrade views at step 0', async () => {
    const pack = sampleContent;
    const resources = pack.modules.resources as readonly NormalizedResource[];
    const generators = pack.modules.generators as readonly NormalizedGenerator[];
    const upgrades = pack.modules.upgrades as readonly NormalizedUpgrade[];
    const automations = (pack.modules.automations ?? []) as readonly NormalizedAutomation[];
    const prestigeLayers = (pack.modules.prestigeLayers ?? []) as readonly NormalizedPrestigeLayer[];

    // Build a deterministic entity lookup so formulas with entity references evaluate safely.
    const baseContext = createDeterministicFormulaEvaluationContext({
      resource: resources.map((r) => r.id),
      generator: generators.map((g) => g.id),
      upgrade: upgrades.map((u) => u.id),
      automation: automations.map((a) => a.id),
      prestigeLayer: prestigeLayers.map((p) => p.id),
    });
    const entities = baseContext.entities;

    const serialized = {
      ids: resources.map((r) => r.id),
      amounts: resources.map((r) => r.startAmount ?? 0),
      capacities: resources.map((r) => (r.capacity == null ? null : r.capacity)),
      unlocked: resources.map((r) => Boolean(r.unlocked)),
      visible: resources.map((r) => Boolean(r.visible)),
      flags: resources.map(() => 0),
    } as const;

    const resourceDisplay = new Map(resources.map((r) => [r.id, { displayName: toDisplayName(r.name) }]));

    const generatorStates = generators.map((g) => ({
      id: g.id,
      displayName: toDisplayName(g.name),
      owned: 0,
      enabled: true,
      isUnlocked: true,
      isVisible: true,
      produces: g.produces.map((p) => ({
        resourceId: p.resourceId,
        rate: evaluateNumericFormula(p.rate as any, {
          variables: { level: 0, time: 0, deltaTime: 1 },
          entities,
        }),
      })),
      consumes: g.consumes.map((c) => ({
        resourceId: c.resourceId,
        rate: evaluateNumericFormula(c.rate as any, {
          variables: { level: 0, time: 0, deltaTime: 1 },
          entities,
        }),
      })),
    }));

    const upgradeStates = upgrades.map((u) => ({
      id: u.id,
      displayName: toDisplayName(u.name),
      status: 'available' as const,
      isVisible: true,
    }));

    const state: ProgressionAuthoritativeState = {
      stepDurationMs: 100,
      resources: { serialized, metadata: resourceDisplay },
      generators: generatorStates,
      generatorPurchases: createGeneratorEvaluator(generators, entities),
      upgrades: upgradeStates,
      upgradePurchases: createUpgradeEvaluator(upgrades, entities),
    };

    const snapshot = buildProgressionSnapshot(0, 0, state);

    // Only compare deterministic generator/upgrade views against the golden file.
    const goldenRaw = await fs.readFile(GOLDEN_PATH, 'utf8');
    const golden = JSON.parse(goldenRaw);

    expect(snapshot.generators).toEqual(golden.generators);
    expect(snapshot.upgrades).toEqual(golden.upgrades);
  });
});
