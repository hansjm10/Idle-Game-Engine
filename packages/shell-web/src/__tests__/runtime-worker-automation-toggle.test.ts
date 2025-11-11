import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initializeRuntimeWorker, type RuntimeWorkerHarness } from '../runtime.worker.js';
import type { RuntimeWorkerCommand } from '@idle-engine/runtime-bridge-contracts';
import { WORKER_MESSAGE_SCHEMA_VERSION, CommandSource } from '@idle-engine/runtime-bridge-contracts';
import { RUNTIME_COMMAND_TYPES } from '@idle-engine/core';

describe('Runtime Worker - Automation Toggle Integration', () => {
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

    harness = initializeRuntimeWorker({
      context: mockContext,
      now: () => 0,
      scheduleTick: (_callback) => {
        // No-op for test
        return () => {};
      },
    });
  });

  afterEach(() => {
    harness?.dispose();
  });

  it('should process TOGGLE_AUTOMATION command', () => {
    const message: RuntimeWorkerCommand = {
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      command: {
        type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
        payload: {
          automationId: 'auto:test',
          enabled: true,
        },
        issuedAt: 0,
      },
    };

    expect(() => {
      harness.handleMessage(message);
    }).not.toThrow();
  });

  it('should have TOGGLE_AUTOMATION handler registered', () => {
    const dispatcher = harness.runtime.getCommandDispatcher();
    const handler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION);

    expect(handler).toBeDefined();
  });
});
