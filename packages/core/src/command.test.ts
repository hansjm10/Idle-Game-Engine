import { describe, expect, it } from 'vitest';

import {
  COMMAND_AUTHORIZATIONS,
  COMMAND_PRIORITY_ORDER,
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
} from './command.js';

describe('command', () => {
  describe('CommandPriority enum', () => {
    it('has SYSTEM with value 0', () => {
      expect(CommandPriority.SYSTEM).toBe(0);
    });

    it('has PLAYER with value 1', () => {
      expect(CommandPriority.PLAYER).toBe(1);
    });

    it('has AUTOMATION with value 2', () => {
      expect(CommandPriority.AUTOMATION).toBe(2);
    });

    it('has exactly 3 priority levels', () => {
      const values = Object.values(CommandPriority).filter(
        (v) => typeof v === 'number',
      );
      expect(values).toHaveLength(3);
    });
  });

  describe('COMMAND_PRIORITY_ORDER', () => {
    it('is frozen array', () => {
      expect(Object.isFrozen(COMMAND_PRIORITY_ORDER)).toBe(true);
    });

    it('contains priorities in execution order', () => {
      expect(COMMAND_PRIORITY_ORDER).toEqual([
        CommandPriority.SYSTEM,
        CommandPriority.PLAYER,
        CommandPriority.AUTOMATION,
      ]);
    });

    it('has same length as priority enum values', () => {
      const enumValues = Object.values(CommandPriority).filter(
        (v) => typeof v === 'number',
      );
      expect(COMMAND_PRIORITY_ORDER).toHaveLength(enumValues.length);
    });
  });

  describe('RUNTIME_COMMAND_TYPES', () => {
    it('is frozen object', () => {
      expect(Object.isFrozen(RUNTIME_COMMAND_TYPES)).toBe(true);
    });

    it('contains expected command types', () => {
      expect(RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR).toBe(
        'PURCHASE_GENERATOR',
      );
      expect(RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE).toBe('PURCHASE_UPGRADE');
      expect(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR).toBe('TOGGLE_GENERATOR');
      expect(RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION).toBe('TOGGLE_AUTOMATION');
      expect(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE).toBe('COLLECT_RESOURCE');
      expect(RUNTIME_COMMAND_TYPES.PRESTIGE_RESET).toBe('PRESTIGE_RESET');
      expect(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP).toBe('OFFLINE_CATCHUP');
      expect(RUNTIME_COMMAND_TYPES.APPLY_MIGRATION).toBe('APPLY_MIGRATION');
      expect(RUNTIME_COMMAND_TYPES.RUN_TRANSFORM).toBe('RUN_TRANSFORM');
      expect(RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION).toBe(
        'MAKE_MISSION_DECISION',
      );
    });

    it('has 17 command types', () => {
      const types = Object.keys(RUNTIME_COMMAND_TYPES);
      expect(types.length).toBe(17);
    });

    it('all values are unique strings', () => {
      const values = Object.values(RUNTIME_COMMAND_TYPES);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
      values.forEach((v) => expect(typeof v).toBe('string'));
    });
  });

  describe('COMMAND_AUTHORIZATIONS', () => {
    it('is frozen object', () => {
      expect(Object.isFrozen(COMMAND_AUTHORIZATIONS)).toBe(true);
    });

    it('has authorization policy for every command type', () => {
      for (const type of Object.values(RUNTIME_COMMAND_TYPES)) {
        expect(COMMAND_AUTHORIZATIONS[type]).toBeDefined();
        expect(COMMAND_AUTHORIZATIONS[type].allowedPriorities).toBeDefined();
      }
    });

    it('each policy type matches its key', () => {
      for (const [key, policy] of Object.entries(COMMAND_AUTHORIZATIONS)) {
        expect(policy.type).toBe(key);
      }
    });

    it('each policy has non-empty allowedPriorities array', () => {
      for (const [type, policy] of Object.entries(COMMAND_AUTHORIZATIONS)) {
        expect(
          Array.isArray(policy.allowedPriorities),
          `${type} should have array allowedPriorities`,
        ).toBe(true);
        expect(
          policy.allowedPriorities.length,
          `${type} should have at least one allowed priority`,
        ).toBeGreaterThan(0);
      }
    });

    it('each policy has a rationale', () => {
      for (const [type, policy] of Object.entries(COMMAND_AUTHORIZATIONS)) {
        expect(
          typeof policy.rationale,
          `${type} should have rationale`,
        ).toBe('string');
        expect(
          policy.rationale.length,
          `${type} rationale should not be empty`,
        ).toBeGreaterThan(0);
      }
    });

    describe('specific command policies', () => {
      it('APPLY_MIGRATION allows only SYSTEM priority', () => {
        const policy =
          COMMAND_AUTHORIZATIONS[RUNTIME_COMMAND_TYPES.APPLY_MIGRATION];
        expect(policy.allowedPriorities).toEqual([CommandPriority.SYSTEM]);
      });

      it('PRESTIGE_RESET excludes AUTOMATION', () => {
        const policy =
          COMMAND_AUTHORIZATIONS[RUNTIME_COMMAND_TYPES.PRESTIGE_RESET];
        expect(policy.allowedPriorities).toContain(CommandPriority.SYSTEM);
        expect(policy.allowedPriorities).toContain(CommandPriority.PLAYER);
        expect(policy.allowedPriorities).not.toContain(
          CommandPriority.AUTOMATION,
        );
      });

      it('PURCHASE_GENERATOR allows all priorities', () => {
        const policy =
          COMMAND_AUTHORIZATIONS[RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR];
        expect(policy.allowedPriorities).toContain(CommandPriority.SYSTEM);
        expect(policy.allowedPriorities).toContain(CommandPriority.PLAYER);
        expect(policy.allowedPriorities).toContain(CommandPriority.AUTOMATION);
      });

      it('ADD_ENTITY_EXPERIENCE excludes PLAYER', () => {
        const policy =
          COMMAND_AUTHORIZATIONS[RUNTIME_COMMAND_TYPES.ADD_ENTITY_EXPERIENCE];
        expect(policy.allowedPriorities).toContain(CommandPriority.SYSTEM);
        expect(policy.allowedPriorities).toContain(CommandPriority.AUTOMATION);
        expect(policy.allowedPriorities).not.toContain(CommandPriority.PLAYER);
      });
    });

    describe('unauthorized events', () => {
      it('PRESTIGE_RESET has custom unauthorized event', () => {
        const policy =
          COMMAND_AUTHORIZATIONS[RUNTIME_COMMAND_TYPES.PRESTIGE_RESET];
        expect(policy.unauthorizedEvent).toBe('AutomationPrestigeBlocked');
      });

      it('APPLY_MIGRATION has custom unauthorized event', () => {
        const policy =
          COMMAND_AUTHORIZATIONS[RUNTIME_COMMAND_TYPES.APPLY_MIGRATION];
        expect(policy.unauthorizedEvent).toBe('UnauthorizedSystemCommand');
      });

      it('commands with all priorities allowed have no unauthorized event', () => {
        const policy =
          COMMAND_AUTHORIZATIONS[RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR];
        expect(policy.unauthorizedEvent).toBeUndefined();
      });
    });
  });
});
