import { describe, it, expect } from 'vitest';
import { RUNTIME_COMMAND_TYPES } from '../command.js';

describe('RUNTIME_COMMAND_TYPES', () => {
  it('should include TOGGLE_AUTOMATION command type', () => {
    expect(RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION).toBe('TOGGLE_AUTOMATION');
  });

  it('should freeze the command types object', () => {
    expect(Object.isFrozen(RUNTIME_COMMAND_TYPES)).toBe(true);
  });
});
