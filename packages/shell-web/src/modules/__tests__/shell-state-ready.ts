import { waitFor } from '@testing-library/react';

import type { ShellState } from '../shell-state.types.js';

export interface ShellReadyOptions {
  readonly timeoutMs?: number;
}

export async function awaitShellStateReady(
  getShellState: () => ShellState,
  options?: ShellReadyOptions,
): Promise<void> {
  const timeout = options?.timeoutMs ?? 2000;

  await waitFor(
    () => {
      const state = getShellState();

      const isReady =
        state.bridge.isReady &&
        !state.bridge.isRestoring &&
        state.bridge.lastUpdateAt !== null &&
        state.runtime.lastSnapshot !== undefined &&
        state.runtime.progression.snapshot !== null;

      if (!isReady) {
        throw new Error('Shell state is not ready yet');
      }
    },
    { timeout },
  );
}

