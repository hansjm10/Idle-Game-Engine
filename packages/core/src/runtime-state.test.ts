import { afterEach, describe, expect, it } from 'vitest';

import { clearGameState, getGameState, setGameState } from './runtime-state.js';

describe('runtime-state', () => {
  afterEach(() => {
    clearGameState();
  });

  describe('setGameState', () => {
    it('returns the same reference that was passed in', () => {
      const state = { resources: [], generators: [] };
      const result = setGameState(state);
      expect(result).toBe(state);
    });

    it('overwrites previous state when called again', () => {
      const first = { id: 'first' };
      const second = { id: 'second' };
      setGameState(first);
      setGameState(second);
      expect(getGameState()).toBe(second);
    });

    it('accepts undefined as a valid state value', () => {
      setGameState(undefined);
      expect(getGameState()).toBeUndefined();
    });

    it('accepts null as a valid state value', () => {
      setGameState(null);
      expect(getGameState()).toBeNull();
    });
  });

  describe('getGameState', () => {
    it('throws Error when no state has been set', () => {
      expect(() => getGameState()).toThrow(
        'Game state has not been initialized. Call setGameState() before restoring snapshots.',
      );
    });

    it('returns the registered state after setGameState', () => {
      const state = { tick: 0 };
      setGameState(state);
      expect(getGameState()).toBe(state);
    });

    it('preserves generic type parameter', () => {
      interface TestState {
        count: number;
      }
      const state: TestState = { count: 42 };
      setGameState(state);
      const retrieved = getGameState<TestState>();
      expect(retrieved.count).toBe(42);
    });
  });

  describe('clearGameState', () => {
    it('resets state so getGameState throws', () => {
      setGameState({ data: 'test' });
      clearGameState();
      expect(() => getGameState()).toThrow();
    });

    it('is idempotent - can be called multiple times', () => {
      clearGameState();
      clearGameState();
      expect(() => getGameState()).toThrow();
    });
  });
});
