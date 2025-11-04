import { describe, it, expect } from 'vitest';
import {
  createAutomationSystem,
  getAutomationState,
  isCooldownActive,
  evaluateIntervalTrigger,
} from './automation-system.js';
import type { AutomationDefinition } from '@idle-engine/content-schema';
import type { AutomationState } from './automation-system.js';

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
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
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
          id: 'auto:collector' as any,
          name: { default: 'Auto Collector', variants: {} },
          description: { default: 'Collects automatically', variants: {} },
          targetType: 'generator',
          targetId: 'gen:clicks' as any,
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
    it('should fire on first tick when lastFiredStep is -Infinity', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:test',
        enabled: true,
        lastFiredStep: -Infinity,
        cooldownExpiresStep: 0,
        unlocked: true,
      };

      const shouldFire = evaluateIntervalTrigger(automation, state, 0, 100);
      expect(shouldFire).toBe(true);
    });

    it('should fire when enough steps have elapsed', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:test',
        enabled: true,
        lastFiredStep: 0,
        cooldownExpiresStep: 0,
        unlocked: true,
      };

      // 1000ms interval / 100ms per step = 10 steps
      const shouldFire = evaluateIntervalTrigger(automation, state, 10, 100);
      expect(shouldFire).toBe(true);
    });

    it('should not fire when interval has not elapsed', () => {
      const automation: AutomationDefinition = {
        id: 'auto:test' as any,
        name: { default: 'Test', variants: {} },
        description: { default: 'Test', variants: {} },
        targetType: 'generator',
        targetId: 'gen:test' as any,
        trigger: { kind: 'interval', interval: { kind: 'constant', value: 1000 } },
        unlockCondition: { kind: 'always' },
        enabledByDefault: true,
        order: 0,
      };

      const state: AutomationState = {
        id: 'auto:test',
        enabled: true,
        lastFiredStep: 0,
        cooldownExpiresStep: 0,
        unlocked: true,
      };

      const shouldFire = evaluateIntervalTrigger(automation, state, 5, 100);
      expect(shouldFire).toBe(false);
    });
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

  describe('cooldown management', () => {
    it('should return true when cooldown is active', () => {
      const state: AutomationState = {
        id: 'auto:test',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 20,
        unlocked: true,
      };

      const isActive = isCooldownActive(state, 15);
      expect(isActive).toBe(true);
    });

    it('should return false when cooldown has expired', () => {
      const state: AutomationState = {
        id: 'auto:test',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 20,
        unlocked: true,
      };

      const isActive = isCooldownActive(state, 20);
      expect(isActive).toBe(false);
    });

    it('should return false when no cooldown is set', () => {
      const state: AutomationState = {
        id: 'auto:test',
        enabled: true,
        lastFiredStep: 10,
        cooldownExpiresStep: 0,
        unlocked: true,
      };

      const isActive = isCooldownActive(state, 15);
      expect(isActive).toBe(false);
    });
  });
});
