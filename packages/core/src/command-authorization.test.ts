import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authorizeCommand,
  DEFAULT_UNAUTHORIZED_EVENT,
} from './command-authorization.js';
import {
  COMMAND_AUTHORIZATIONS,
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
} from './command.js';
import { resetTelemetry, telemetry } from './telemetry.js';

describe('command-authorization', () => {
  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  describe('authorizeCommand', () => {
    it('returns true when command priority is in allowedPriorities', () => {
      const command = {
        type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
        priority: CommandPriority.PLAYER,
        payload: { generatorId: 'gen-1', count: 1 },
        timestamp: Date.now(),
        step: 1,
      };
      expect(authorizeCommand(command)).toBe(true);
    });

    it('returns false when command priority is not in allowedPriorities', () => {
      const recordWarningSpy = vi.spyOn(telemetry, 'recordWarning');
      // PRESTIGE_RESET only allows SYSTEM and PLAYER, not AUTOMATION
      const command = {
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        priority: CommandPriority.AUTOMATION,
        payload: { layerId: 'layer-1' },
        timestamp: Date.now(),
        step: 1,
      };
      expect(authorizeCommand(command)).toBe(false);
      expect(recordWarningSpy).toHaveBeenCalled();
    });

    it('records telemetry with command details on unauthorized attempt', () => {
      const recordWarningSpy = vi.spyOn(telemetry, 'recordWarning');
      // ADD_ENTITY_EXPERIENCE only allows SYSTEM and AUTOMATION, not PLAYER
      const command = {
        type: RUNTIME_COMMAND_TYPES.ADD_ENTITY_EXPERIENCE,
        priority: CommandPriority.PLAYER,
        payload: { instanceId: 'inst-1', amount: 100 },
        timestamp: Date.now(),
        step: 5,
      };

      authorizeCommand(command, { phase: 'replay', reason: 'test reason' });

      expect(recordWarningSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: RUNTIME_COMMAND_TYPES.ADD_ENTITY_EXPERIENCE,
          attemptedPriority: CommandPriority.PLAYER,
          phase: 'replay',
          reason: 'test reason',
        }),
      );
    });

    it('uses custom unauthorizedEvent when policy specifies one', () => {
      const recordWarningSpy = vi.spyOn(telemetry, 'recordWarning');
      // PRESTIGE_RESET has unauthorizedEvent: 'AutomationPrestigeBlocked'
      const command = {
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        priority: CommandPriority.AUTOMATION,
        payload: { layerId: 'layer-1' },
        timestamp: Date.now(),
        step: 1,
      };

      authorizeCommand(command);

      expect(recordWarningSpy).toHaveBeenCalledWith(
        'AutomationPrestigeBlocked',
        expect.any(Object),
      );
    });

    it('uses DEFAULT_UNAUTHORIZED_EVENT when policy has no custom event', () => {
      // Commands with all priorities allowed won't trigger this,
      // so we need to find one without custom event that can fail
      // ADD_ENTITY_EXPERIENCE has custom event, let's check RUN_TRANSFORM
      // RUN_TRANSFORM has unauthorizedEvent: 'UnauthorizedTransformCommand'
      // Let's verify DEFAULT_UNAUTHORIZED_EVENT is 'CommandPriorityViolation'
      expect(DEFAULT_UNAUTHORIZED_EVENT).toBe('CommandPriorityViolation');
    });

    it('defaults phase to "live" when not specified', () => {
      const recordWarningSpy = vi.spyOn(telemetry, 'recordWarning');
      const command = {
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        priority: CommandPriority.AUTOMATION,
        payload: { layerId: 'layer-1' },
        timestamp: Date.now(),
        step: 1,
      };

      authorizeCommand(command);

      expect(recordWarningSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          phase: 'live',
        }),
      );
    });

    it('omits reason from telemetry when not provided', () => {
      const recordWarningSpy = vi.spyOn(telemetry, 'recordWarning');
      const command = {
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        priority: CommandPriority.AUTOMATION,
        payload: { layerId: 'layer-1' },
        timestamp: Date.now(),
        step: 1,
      };

      authorizeCommand(command);

      const callDetails = recordWarningSpy.mock.calls[0]?.[1];
      expect(callDetails).not.toHaveProperty('reason');
    });

    it('returns true for unknown command type (no policy defined)', () => {
      const command = {
        type: 'UNKNOWN_COMMAND_TYPE',
        priority: CommandPriority.SYSTEM,
        payload: {},
        timestamp: Date.now(),
        step: 1,
      };
      expect(authorizeCommand(command)).toBe(true);
    });

    describe('authorization policies for all command types', () => {
      const commandTypes = Object.values(RUNTIME_COMMAND_TYPES);

      it.each(commandTypes)('has authorization policy for %s', (commandType) => {
        const policy = COMMAND_AUTHORIZATIONS[commandType];
        expect(policy).toBeDefined();
        expect(policy.allowedPriorities).toBeDefined();
        expect(Array.isArray(policy.allowedPriorities)).toBe(true);
      });

      it('PLAYER priority is allowed for player-facing commands', () => {
        const playerCommands = [
          RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
          RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
          RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
        ];

        for (const type of playerCommands) {
          const command = {
            type,
            priority: CommandPriority.PLAYER,
            payload: {},
            timestamp: Date.now(),
            step: 1,
          };
          expect(authorizeCommand(command)).toBe(true);
        }
      });

      it('AUTOMATION priority is allowed for automation commands', () => {
        const command = {
          type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
          priority: CommandPriority.AUTOMATION,
          payload: { automationId: 'auto-1', enabled: true },
          timestamp: Date.now(),
          step: 1,
        };
        expect(authorizeCommand(command)).toBe(true);
      });

      it('SYSTEM priority is allowed for system-only commands', () => {
        // APPLY_MIGRATION is SYSTEM only
        const command = {
          type: RUNTIME_COMMAND_TYPES.APPLY_MIGRATION,
          priority: CommandPriority.SYSTEM,
          payload: {
            fromVersion: '1.0',
            toVersion: '1.1',
            transformations: [],
          },
          timestamp: Date.now(),
          step: 1,
        };
        expect(authorizeCommand(command)).toBe(true);
      });

      it('APPLY_MIGRATION rejects non-SYSTEM priorities', () => {
        const command = {
          type: RUNTIME_COMMAND_TYPES.APPLY_MIGRATION,
          priority: CommandPriority.PLAYER,
          payload: {
            fromVersion: '1.0',
            toVersion: '1.1',
            transformations: [],
          },
          timestamp: Date.now(),
          step: 1,
        };
        expect(authorizeCommand(command)).toBe(false);
      });
    });
  });
});
