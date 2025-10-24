import type { ResourceState } from '../resource-state.js';
import type { GeneratorState } from '../generator-state.js';
import type { UpgradeState } from '../upgrade-state.js';
import type { RuntimeChangeJournal } from '../runtime-change-journal.js';
import type { TickContext } from './system-types.js';
import type { SystemDefinition } from './system-types.js';

export interface EventSystemOptions {
  readonly resources?: ResourceState;
  readonly generators?: GeneratorState;
  readonly upgrades?: UpgradeState;
  readonly journal?: RuntimeChangeJournal;
  readonly id?: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export function createEventSystem(options: EventSystemOptions = {}): SystemDefinition {
  const {
    resources,
    generators,
    upgrades,
    journal,
    id = 'events',
    before,
    after,
  } = options;

  return {
    id,
    before,
    after,
    tick(context: TickContext) {
      if (resources) {
        resources.finalizeTick(context.deltaMs);
        resources.snapshot();
        resources.resetPerTickAccumulators();
        resources.clearDirtyScratch();
      }

      if (generators) {
        generators.snapshot();
        generators.clearDirty();
      }

      if (upgrades) {
        upgrades.snapshot();
        upgrades.clearDirty();
      }

      if (journal) {
        journal.capture({
          tick: context.step,
          resources,
          generators,
          upgrades,
        });
      }
    },
  };
}
