import { describe, it, expect } from 'vitest';
import {
  SYSTEM_AUTOMATION_TARGET_MAPPING,
  mapSystemTargetToCommandType,
} from './system-automation-target-mapping.js';
import { RUNTIME_COMMAND_TYPES } from './command.js';

describe('system-automation-target-mapping', () => {
  describe('SYSTEM_AUTOMATION_TARGET_MAPPING', () => {
    it('should map offline-catchup to OFFLINE_CATCHUP', () => {
      expect(SYSTEM_AUTOMATION_TARGET_MAPPING['offline-catchup']).toBe(
        RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      );
    });

    it('should map research-daemon to a valid command type', () => {
      const mapped = SYSTEM_AUTOMATION_TARGET_MAPPING['research-daemon'];
      expect(mapped).toBeDefined();
      expect(typeof mapped).toBe('string');
    });

    it('should have entries for all known system targets', () => {
      const knownTargets = ['offline-catchup', 'research-daemon'];
      for (const target of knownTargets) {
        expect(SYSTEM_AUTOMATION_TARGET_MAPPING[target]).toBeDefined();
      }
    });
  });

  describe('mapSystemTargetToCommandType', () => {
    it('should map offline-catchup to OFFLINE_CATCHUP', () => {
      expect(mapSystemTargetToCommandType('offline-catchup')).toBe(
        RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      );
    });

    it('should map research-daemon to valid command type', () => {
      const result = mapSystemTargetToCommandType('research-daemon');
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('should throw for unknown system target', () => {
      expect(() =>
        mapSystemTargetToCommandType('unknown-target' as any),
      ).toThrow(/unknown system automation target/i);
    });

    it('should provide helpful error message with target id', () => {
      expect(() =>
        mapSystemTargetToCommandType('invalid-id' as any),
      ).toThrow('invalid-id');
    });
  });
});
