import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initializeRuntimeWorker, type RuntimeWorkerHarness } from '../runtime.worker.js';
import {
  type RuntimeWorkerStateUpdate,
  type RuntimeWorkerCommand,
  CommandSource,
  WORKER_MESSAGE_SCHEMA_VERSION,
} from '../modules/runtime-worker-protocol.js';
import { getAutomationState } from '@idle-engine/core';

describe('AutomationSystem Integration', () => {
  let harness: RuntimeWorkerHarness;
  let messages: unknown[];
  let mockContext: DedicatedWorkerGlobalScope;

  beforeEach(() => {
    messages = [];

    // Mock DedicatedWorkerGlobalScope
    mockContext = {
      postMessage: vi.fn((msg: unknown) => {
        messages.push(msg);
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    } as unknown as DedicatedWorkerGlobalScope;
  });

  afterEach(() => {
    harness?.dispose();
  });

  it('should register AutomationSystem in runtime', () => {
    let currentTime = 0;
    harness = initializeRuntimeWorker({
      context: mockContext,
      now: () => currentTime,
      scheduleTick: (_callback) => {
        // Don't auto-tick in this test
        return () => {};
      },
      stepSizeMs: 100,
    });

    // Verify AutomationSystem is registered by checking observable behavior:
    // Ticking should trigger interval automations to enqueue commands
    const queueSizeBefore = harness.runtime.getCommandQueue().size;

    // Tick to trigger interval automation (auto-reactor fires immediately on first tick)
    currentTime += 100;
    harness.tick();

    const queueSizeAfter = harness.runtime.getCommandQueue().size;

    // Verify that automation commands were enqueued
    // (sample-pack.auto-reactor is enabled by default and fires on first tick)
    expect(queueSizeAfter).toBeGreaterThan(queueSizeBefore);
  });

  // SKIPPED: Requires TOGGLE_GENERATOR command handler (issue #324)
  // This test will be enabled once generator toggle commands are implemented
  it.skip('should fire interval automation after sufficient ticks', () => {
    let currentTime = 0;
    const stepSizeMs = 100;

    harness = initializeRuntimeWorker({
      context: mockContext,
      now: () => currentTime,
      scheduleTick: (_callback) => {
        return () => {};
      },
      stepSizeMs,
    });

    // Clear initial READY message
    messages.length = 0;

    // Tick multiple times to trigger interval automation
    // sample-pack.auto-reactor has 5000ms interval = 50 steps at 100ms each
    for (let i = 0; i < 51; i++) {
      currentTime += stepSizeMs;
      harness.tick();
    }

    // Check that STATE_UPDATE messages include automation command execution
    const stateUpdates = messages.filter(
      (msg: any) => msg.type === 'STATE_UPDATE'
    ) as RuntimeWorkerStateUpdate[];

    expect(stateUpdates.length).toBeGreaterThan(0);

    // Verify at least one state update shows reactor generator was toggled
    // (automation fired and executed the TOGGLE_GENERATOR command)
    const finalState = stateUpdates[stateUpdates.length - 1];
    const reactorGenerator = finalState.state.progression.generators.find(
      (g) => g.id === 'sample-pack.reactor'
    );

    expect(reactorGenerator).toBeDefined();
    // Verify the automation actually toggled the generator's state
    expect(reactorGenerator?.enabled).toBe(true);
  });

  it('should toggle automation via TOGGLE_AUTOMATION command', () => {
    let currentTime = 0;
    harness = initializeRuntimeWorker({
      context: mockContext,
      now: () => currentTime,
      scheduleTick: (_callback) => {
        return () => {};
      },
      stepSizeMs: 100,
    });

    // Clear initial messages
    messages.length = 0;

    // Get automation system to verify state
    const automationSystem = harness.getAutomationSystem();

    // Verify initial state - sample-pack.auto-reactor should be enabled by default
    const initialState = getAutomationState(automationSystem);
    const initialAutomation = initialState.get('sample-pack.auto-reactor');
    expect(initialAutomation).toBeDefined();
    expect(initialAutomation?.enabled).toBe(true);

    // Disable automation
    const disableMessage: RuntimeWorkerCommand = {
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      command: {
        type: 'TOGGLE_AUTOMATION',
        payload: {
          automationId: 'sample-pack.auto-reactor',
          enabled: false,
        },
        issuedAt: currentTime,
      },
    };

    // Command should be processed without throwing
    expect(() => {
      harness.handleMessage(disableMessage);
    }).not.toThrow();

    // Tick to process the command
    currentTime += 100;
    harness.tick();

    // Verify automation was disabled
    const disabledState = getAutomationState(automationSystem);
    const disabledAutomation = disabledState.get('sample-pack.auto-reactor');
    expect(disabledAutomation).toBeDefined();
    expect(disabledAutomation?.enabled).toBe(false);

    // Verify that STATE_UPDATE messages were sent (confirming runtime is processing)
    const stateUpdatesAfterDisable = messages.filter((msg: any) => msg.type === 'STATE_UPDATE');
    expect(stateUpdatesAfterDisable.length).toBeGreaterThan(0);

    // Clear messages for enable test
    messages.length = 0;

    // Re-enable the automation
    const enableMessage: RuntimeWorkerCommand = {
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      command: {
        type: 'TOGGLE_AUTOMATION',
        payload: {
          automationId: 'sample-pack.auto-reactor',
          enabled: true,
        },
        issuedAt: currentTime,
      },
    };

    expect(() => {
      harness.handleMessage(enableMessage);
    }).not.toThrow();

    currentTime += 100;
    harness.tick();

    // Verify automation was re-enabled
    const enabledState = getAutomationState(automationSystem);
    const enabledAutomation = enabledState.get('sample-pack.auto-reactor');
    expect(enabledAutomation).toBeDefined();
    expect(enabledAutomation?.enabled).toBe(true);

    // Verify that STATE_UPDATE messages were sent
    const stateUpdatesAfterEnable = messages.filter((msg: any) => msg.type === 'STATE_UPDATE');
    expect(stateUpdatesAfterEnable.length).toBeGreaterThan(0);
  });
});
