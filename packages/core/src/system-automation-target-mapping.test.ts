import { describe, it, expect } from 'vitest';
import {
  SYSTEM_AUTOMATION_TARGET_MAPPING,
  mapSystemTargetToCommandType,
} from './system-automation-target-mapping.js';
import { RUNTIME_COMMAND_TYPES } from './command.js';
import { SYSTEM_AUTOMATION_TARGET_IDS } from '@idle-engine/content-schema';

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

  describe('mapping synchronization', () => {
    it('should have mapping for every content schema system target', () => {
      // This test ensures the mapping stays in sync with the content schema.
      // If this fails, update SYSTEM_AUTOMATION_TARGET_MAPPING.
      const schemaTargets = Array.from(SYSTEM_AUTOMATION_TARGET_IDS);
      const mappedTargets = Object.keys(SYSTEM_AUTOMATION_TARGET_MAPPING);

      for (const target of schemaTargets) {
        expect(
          SYSTEM_AUTOMATION_TARGET_MAPPING[target],
          `Missing mapping for schema target: ${target}`,
        ).toBeDefined();
      }

      // Verify no extra mappings (helps catch typos)
      for (const target of mappedTargets) {
        expect(
          schemaTargets.includes(target),
          `Mapping contains unknown target: ${target}`,
        ).toBe(true);
      }
    });
  });
});
