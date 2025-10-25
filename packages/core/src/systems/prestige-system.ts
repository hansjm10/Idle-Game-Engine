import type { ResourceState, ResourceSpendAttemptContext } from '../resource-state.js';
import type { GeneratorState } from '../generator-state.js';
import type { UpgradeState } from '../upgrade-state.js';
import type { TickContext } from './system-types.js';
import type { SystemDefinition } from './system-types.js';

export interface PrestigeResetRequest {
  readonly layer: number;
  readonly resourceRetention?: Readonly<Record<string, number>>;
  readonly grantUpgrades?: ReadonlyArray<{ upgradeId: string; count: number }>;
}

export class PrestigeResetQueue {
  private readonly queue: PrestigeResetRequest[] = [];

  enqueue(request: PrestigeResetRequest): void {
    this.queue.push(request);
  }

  drain(): PrestigeResetRequest[] {
    if (this.queue.length === 0) {
      return [];
    }
    return this.queue.splice(0, this.queue.length);
  }
}

export interface PrestigeSystemOptions {
  readonly resources: ResourceState;
  readonly generators: GeneratorState;
  readonly upgrades: UpgradeState;
  readonly queue: PrestigeResetQueue;
  readonly id?: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export function createPrestigeSystem(options: PrestigeSystemOptions): SystemDefinition {
  const {
    resources,
    generators,
    upgrades,
    queue,
    id = 'prestige',
    before,
    after,
  } = options;

  return {
    id,
    before,
    after,
    tick(context: TickContext) {
      const resets = queue.drain();
      if (resets.length === 0) {
        return;
      }

      for (const request of resets) {
        applyReset(resources, generators, upgrades, request);
        context.events.publish('prestige:reset', {
          layer: request.layer,
        });
      }
    },
  };
}

function applyReset(
  resources: ResourceState,
  generators: GeneratorState,
  upgrades: UpgradeState,
  request: PrestigeResetRequest,
): void {
  const retention = request.resourceRetention ?? {};

  resources.forceClearDirtyState();

  for (const resourceId of resources.collectRecords().map((record) => record.id)) {
    const index = resources.requireIndex(resourceId);
    const current = resources.getAmount(index);
    const multiplier = retention[resourceId] ?? 0;
    const target = Math.max(0, current * multiplier);
    const delta = target - current;
    adjustResourceAmount(resources, index, delta);
    resources.unlock(index);
  }

  for (const generator of generators.collectRecords()) {
    const index = generators.requireIndex(generator.id);
    generators.setLevel(index, 0);
    generators.unlock(index);
  }

  for (const upgrade of upgrades.collectRecords()) {
    const index = upgrades.requireIndex(upgrade.id);
    upgrades.resetPurchaseCount(index);
    upgrades.unlock(index);
  }

  if (request.grantUpgrades) {
    for (const grant of request.grantUpgrades) {
      const index = upgrades.getIndex(grant.upgradeId);
      if (index === undefined) {
        continue;
      }
      upgrades.setPurchaseCount(index, grant.count);
    }
  }
}

function adjustResourceAmount(
  resources: ResourceState,
  index: number,
  delta: number,
): void {
  if (delta > 0) {
    resources.addAmount(index, delta);
    return;
  }
  if (delta < 0) {
    const context: ResourceSpendAttemptContext = {
      systemId: 'prestige',
    };
    resources.spendAmount(index, -delta, context);
  }
}
