import type { ResourceState, ResourceStateView } from './resource-state.js';
import type { GeneratorState, GeneratorStateView } from './generator-state.js';
import type { UpgradeState, UpgradeStateView } from './upgrade-state.js';
import { createReadOnlyProxy } from './read-only-proxy.js';

export interface RuntimeStateView {
  readonly resources?: ResourceStateView;
  readonly generators?: GeneratorStateView;
  readonly upgrades?: UpgradeStateView;
}

export interface RuntimeStateViewOptions {
  readonly resources?: ResourceState;
  readonly generators?: GeneratorState;
  readonly upgrades?: UpgradeState;
}

export function createRuntimeStateView(options: RuntimeStateViewOptions): RuntimeStateView {
  const snapshot: RuntimeStateView = {
    resources: options.resources?.view(),
    generators: options.generators?.view(),
    upgrades: options.upgrades?.view(),
  };
  return createReadOnlyProxy(snapshot, 'runtimeStateView');
}
