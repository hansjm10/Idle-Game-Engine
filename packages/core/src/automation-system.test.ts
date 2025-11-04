import { describe, it, expect } from 'vitest';
import { createAutomationSystem, getAutomationState } from './automation-system.js';
import type { AutomationDefinition } from '@idle-engine/content-schema';

describe('AutomationSystem', () => {
  const stepDurationMs = 100;

  describe('initialization', () => {
    it('should create system with correct id', () => {
      const system = createAutomationSystem({
        automations: [],
        stepDurationMs,
      });

      expect(system.id).toBe('automation-system');
    });

    it('should initialize automation states with default values', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector',
          name: { en: 'Auto Collector' },
          description: { en: 'Collects automatically' },
          targetType: 'generator',
          targetId: 'gen:clicks',
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
      });

      // We need a way to inspect state - will add getter
      const state = getAutomationState(system);

      expect(state.size).toBe(1);
      const autoState = state.get('auto:collector');
      expect(autoState).toBeDefined();
      expect(autoState?.enabled).toBe(true);
      expect(autoState?.lastFiredStep).toBe(-Infinity);
      expect(autoState?.cooldownExpiresStep).toBe(0);
      expect(autoState?.unlocked).toBe(false);
    });

    it('should restore state from initialState', () => {
      const automations: AutomationDefinition[] = [
        {
          id: 'auto:collector',
          name: { en: 'Auto Collector' },
          description: { en: 'Collects automatically' },
          targetType: 'generator',
          targetId: 'gen:clicks',
          trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
          unlockCondition: { kind: 'always' },
          enabledByDefault: true,
          order: 0,
        },
      ];

      const initialState = new Map([
        ['auto:collector', {
          id: 'auto:collector',
          enabled: false,
          lastFiredStep: 100,
          cooldownExpiresStep: 110,
          unlocked: true,
        }],
      ]);

      const system = createAutomationSystem({
        automations,
        stepDurationMs: 100,
        initialState,
      });

      const state = getAutomationState(system);
      const autoState = state.get('auto:collector');

      expect(autoState?.enabled).toBe(false);
      expect(autoState?.lastFiredStep).toBe(100);
      expect(autoState?.cooldownExpiresStep).toBe(110);
      expect(autoState?.unlocked).toBe(true);
    });
  });

  describe('interval triggers', () => {
    // Tests to be added
  });

  describe('resourceThreshold triggers', () => {
    // Tests to be added
  });

  describe('commandQueueEmpty triggers', () => {
    // Tests to be added
  });

  describe('event triggers', () => {
    // Tests to be added
  });
});
