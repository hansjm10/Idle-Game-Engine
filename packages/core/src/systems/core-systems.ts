import type { IdleEngineRuntime } from '../index.js';
import type { RegisterSystemsResult } from './system-registry.js';
import { registerSystems } from './system-registry.js';
import { GeneratorModifierLedger } from './modifier-ledger.js';
import {
  createProductionSystem,
  type ProductionSystemOptions,
} from './production-system.js';
import {
  createUpgradeSystem,
  type UpgradeSystemOptions,
} from './upgrade-system.js';
import {
  createPrestigeSystem,
  type PrestigeSystemOptions,
} from './prestige-system.js';
import {
  createTaskSystem,
  type TaskSystemOptions,
} from './task-system.js';
import {
  createSocialSystem,
  type SocialSystemOptions,
} from './social-system.js';
import {
  createEventSystem,
  type EventSystemOptions,
} from './event-system.js';
import type { SystemDefinition } from './system-types.js';

export interface CoreSystemsOptions {
  readonly production: Omit<ProductionSystemOptions, 'ledger'>;
  readonly upgrades: Omit<UpgradeSystemOptions, 'ledger'>;
  readonly prestige: PrestigeSystemOptions;
  readonly tasks?: TaskSystemOptions;
  readonly social?: SocialSystemOptions;
  readonly events: EventSystemOptions;
  readonly ledger?: GeneratorModifierLedger;
}

export interface CoreSystemsResult {
  readonly order: readonly string[];
  readonly ledger: GeneratorModifierLedger;
}

export function registerCoreSystems(
  runtime: IdleEngineRuntime,
  options: CoreSystemsOptions,
): CoreSystemsResult {
  const ledger = options.ledger ?? new GeneratorModifierLedger();

  const upgradeId = options.upgrades.id ?? 'upgrades';
  const productionId = options.production.id ?? 'production';
  const prestigeId = options.prestige.id ?? 'prestige';
  const tasksId = options.tasks?.id ?? 'tasks';
  const socialId = options.social?.id ?? 'social';
  const eventsId = options.events.id ?? 'events';

  const upgradeSystem = createUpgradeSystem({
    ...options.upgrades,
    ledger,
    before: mergeConstraints(options.upgrades.before, [productionId]),
  });

  const productionSystem = createProductionSystem({
    ...options.production,
    ledger,
    after: mergeConstraints(options.production.after, [upgradeId]),
    before: mergeConstraints(options.production.before, [prestigeId]),
  });

  const prestigeBefore: string[] = [];
  if (options.tasks) {
    prestigeBefore.push(tasksId);
  } else if (options.social) {
    prestigeBefore.push(socialId);
  } else {
    prestigeBefore.push(eventsId);
  }

  const prestigeSystem = createPrestigeSystem({
    ...options.prestige,
    after: mergeConstraints(options.prestige.after, [productionId]),
    before: mergeConstraints(options.prestige.before, prestigeBefore),
  });

  const definitions: SystemDefinition[] = [
    upgradeSystem,
    productionSystem,
    prestigeSystem,
  ];

  if (options.tasks) {
    const tasksSystem = createTaskSystem({
      ...options.tasks,
      after: mergeConstraints(options.tasks.after, [prestigeId]),
      before: mergeConstraints(options.tasks.before, [
        options.social ? socialId : eventsId,
      ]),
    });
    definitions.push(tasksSystem);
  }

  if (options.social) {
    const socialAfter = options.tasks ? [tasksId] : [prestigeId];
    const socialSystem = createSocialSystem({
      ...options.social,
      after: mergeConstraints(options.social.after, socialAfter),
      before: mergeConstraints(options.social.before, [eventsId]),
    });
    definitions.push(socialSystem);
  }

  const eventAfter: string[] = [];
  if (options.social) {
    eventAfter.push(socialId);
  } else if (options.tasks) {
    eventAfter.push(tasksId);
  } else {
    eventAfter.push(prestigeId);
  }

  const eventSystem = createEventSystem({
    ...options.events,
    after: mergeConstraints(options.events.after, eventAfter),
  });
  definitions.push(eventSystem);

  const result: RegisterSystemsResult = registerSystems(runtime, definitions);

  return {
    order: result.order,
    ledger,
  };
}

function mergeConstraints(
  base: readonly string[] | undefined,
  additions: readonly string[] | undefined,
): readonly string[] | undefined {
  const set = new Set<string>(base ?? []);
  if (additions) {
    for (const id of additions) {
      if (id) {
        set.add(id);
      }
    }
  }
  return set.size > 0 ? Object.freeze(Array.from(set)) : base;
}
