import type {
  ProgressionCoordinator,
  ProgressionCoordinatorOptions,
} from './progression/progression-coordinator-types.js';
import { ProgressionFacade } from './progression/progression-facade.js';

export type {
  ProgressionCoordinator,
  ProgressionCoordinatorOptions,
} from './progression/progression-coordinator-types.js';

/**
 * Create a ProgressionCoordinator instance.
 *
 * This function is the stable public entry point; the current implementation is
 * a facade that coordinates focused managers (see `ProgressionFacade`).
 */
export function createProgressionCoordinator(
  options: ProgressionCoordinatorOptions,
): ProgressionCoordinator {
  return new ProgressionFacade(options);
}
