let hasActiveGameState = false;
let activeGameState: unknown;

/**
 * Register the mutable runtime game state reference so snapshot restoration can
 * reconcile into the existing object graph without replacing references.
 */
export function setGameState<TState>(state: TState): TState {
  activeGameState = state;
  hasActiveGameState = true;
  return state;
}

/**
 * Retrieve the currently registered runtime game state reference.
 */
export function getGameState<TState>(): TState {
  if (!hasActiveGameState) {
    throw new Error(
      'Game state has not been initialized. Call setGameState() before restoring snapshots.',
    );
  }
  return activeGameState as TState;
}

/**
 * Clear the registered runtime game state reference. Primarily used by tests.
 */
export function clearGameState(): void {
  activeGameState = undefined;
  hasActiveGameState = false;
}
