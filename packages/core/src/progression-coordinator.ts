import type {
  ProgressionCoordinator,
  ProgressionCoordinatorOptions,
} from './progression/progression-coordinator-types.js';
import { ProgressionFacade } from './progression/progression-facade.js';

export type {
  ProgressionCoordinator,
  ProgressionCoordinatorOptions,
} from './progression/progression-coordinator-types.js';

export function createProgressionCoordinator(
  options: ProgressionCoordinatorOptions,
): ProgressionCoordinator {
  return new ProgressionFacade(options);
}

