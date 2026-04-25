import { describe, expect, it, vi } from 'vitest';

import {
  sampleContentArtifactHash,
  sampleContentSummary,
} from '@idle-engine/content-sample';
import { CommandPriority, IdleEngineRuntime, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { createSimRuntime, loadSerializedSimRuntimeState } from './sim-runtime.js';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE } from '../ipc.js';
import type {
  Command,
  InputEventCommandPayload,
  PointerInputEvent,
  RuntimeCommandPayloads,
} from '@idle-engine/core';
import type { RenderCommandBuffer, RenderDraw } from '@idle-engine/renderer-contract';

const SAMPLE_ENERGY_RESOURCE_ID = 'sample-pack.energy';

const collectEnergyCommand = (
  step: number,
  amount = 1,
): Command => ({
  type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
  priority: CommandPriority.PLAYER,
  payload: { resourceId: SAMPLE_ENERGY_RESOURCE_ID, amount },
  timestamp: 0,
  step,
});

const pointerPayload = (x: number, y: number): InputEventCommandPayload => ({
  schemaVersion: 1,
  event: {
    kind: 'pointer',
    intent: 'mouse-down',
    phase: 'start',
    x,
    y,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    modifiers: { alt: false, ctrl: false, meta: false, shift: false },
  },
});

const textContent = (frame: RenderCommandBuffer | undefined): readonly string[] =>
  frame?.draws
    .filter((draw): draw is Extract<RenderDraw, { kind: 'text' }> => draw.kind === 'text')
    .map((draw) => draw.text) ?? [];

const hasText = (
  frame: RenderCommandBuffer | undefined,
  expected: string | RegExp,
): boolean => {
  const texts = textContent(frame);
  return typeof expected === 'string'
    ? texts.includes(expected)
    : texts.some((text) => expected.test(text));
};

const energyFillWidth = (frame: RenderCommandBuffer | undefined): number | undefined => {
  const fills = frame?.draws.filter(
    (draw): draw is Extract<RenderDraw, { kind: 'rect' }> =>
      draw.kind === 'rect' &&
      draw.passId === 'ui' &&
      draw.x === 32 &&
      draw.y === 110 &&
      draw.height === 10,
  );
  return fills?.at(-1)?.width;
};

describe('shell-desktop sim runtime', () => {
  it('emits per-step frames with deterministic timing from the sample pack', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const result = sim.tick(35);
    expect(result.frames).toHaveLength(3);
    expect(result.frames[0]?.frame.step).toBe(0);
    expect(result.frames[0]?.frame.simTimeMs).toBe(0);
    expect(result.frames[0]?.frame.contentHash).toBe(sampleContentArtifactHash);
    expect(result.frames[2]?.frame.step).toBe(2);
    expect(result.frames[2]?.frame.simTimeMs).toBe(20);
    expect(result.nextStep).toBe(3);
    expect(sim.getNextStep()).toBe(3);
    expect(sim.getStepSizeMs()).toBe(10);
    expect(hasText(result.frames[0], 'Sample Content Pack')).toBe(true);
    expect(hasText(result.frames[0], 'Energy: 10 / 100 +0/s')).toBe(true);
    expect(hasText(result.frames[0], /^Reactor: owned 0/)).toBe(true);
    expect(energyFillWidth(result.frames[0])).toBe(40);
  });

  it('drains command outcomes after each tick', () => {
    const drainCommandOutcomes = vi.spyOn(
      IdleEngineRuntime.prototype,
      'drainCommandOutcomes',
    );

    try {
      const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

      sim.tick(10);

      expect(drainCommandOutcomes).toHaveBeenCalledTimes(1);
    } finally {
      drainCommandOutcomes.mockRestore();
    }
  });

  it('executes real collect resource commands and reflects them in the next frame', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([collectEnergyCommand(sim.getNextStep())]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.frame.step).toBe(0);
    expect(hasText(result.frames[0], 'Energy: 11 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(result.frames[0])).toBe(44);
  });

  it('trims fractional resource labels without regex backtracking', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([collectEnergyCommand(sim.getNextStep(), 0.5)]);

    const result = sim.tick(10);
    expect(hasText(result.frames[0], 'Energy: 10.5 / 100 +0/s')).toBe(true);
  });

  it('keeps the sample-pack state unchanged for unknown resource ids', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        payload: { resourceId: 'other', amount: 1 },
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    const result = sim.tick(10);

    expect(hasText(result.frames[0], 'Energy: 10 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(result.frames[0])).toBe(40);
  });

  it('drops invalid commands from the queue', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([{} as unknown as Command]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.frame.step).toBe(0);
    expect(hasText(result.frames[0], 'Energy: 10 / 100 +0/s')).toBe(true);
  });

  it('drops commands with invalid fields', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      null as unknown as Command,
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: Number.NaN,
        payload: { resourceId: SAMPLE_ENERGY_RESOURCE_ID, amount: 1 },
        timestamp: 0,
        step: 0,
      },
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        payload: { resourceId: SAMPLE_ENERGY_RESOURCE_ID, amount: 1 },
        timestamp: 0,
        step: Number.NaN,
      },
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        priority: CommandPriority.PLAYER,
        payload: { resourceId: SAMPLE_ENERGY_RESOURCE_ID, amount: 1 },
        timestamp: Number.NaN,
        step: 0,
      },
    ]);

    const result = sim.tick(10);

    expect(hasText(result.frames[0], 'Energy: 10 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(result.frames[0])).toBe(40);
  });

  it('normalizes commands scheduled before the next step', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const command = collectEnergyCommand(-5);

    sim.enqueueCommands([command]);

    const result = sim.tick(10);

    expect(hasText(result.frames[0], 'Energy: 11 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(result.frames[0])).toBe(44);
  });

  it('renders generator ownership after real sample-pack purchase commands', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      collectEnergyCommand(sim.getNextStep(), 90),
      {
        type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
        priority: CommandPriority.PLAYER,
        payload: { generatorId: 'sample-pack.reactor', count: 1 },
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    const result = sim.tick(10);

    expect(hasText(result.frames[0], /^Reactor: owned 1/)).toBe(true);
  });

  it('registers a handler for passthrough control event commands', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    expect(sim.hasCommandHandler(SHELL_CONTROL_EVENT_COMMAND_TYPE)).toBe(true);
  });

  it('registers a handler for INPUT_EVENT commands', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    expect(sim.hasCommandHandler(RUNTIME_COMMAND_TYPES.INPUT_EVENT)).toBe(true);
  });

  it('reports save/load and offline catch-up capabilities', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    expect(sim.getCapabilities?.()).toEqual({
      canSerialize: true,
      canHydrate: true,
      supportsOfflineCatchup: true,
      saveFileStem: 'sample-pack',
      saveSchemaVersion: 1,
      contentHash: sampleContentArtifactHash,
      contentVersion: sampleContentSummary.version,
    });
  });

  it('serializes and restores runtime state deterministically', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([collectEnergyCommand(sim.getNextStep(), 2)]);
    sim.tick(10);

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    const restored = createSimRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 50,
      initialSerializedState: savedState,
    });

    expect(restored.getNextStep()).toBe(savedState.nextStep);

    const result = restored.tick(10);
    expect(hasText(result.frames[0], 'Energy: 12 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(result.frames[0])).toBe(48);
  });

  it('renders the last completed frame after restoring serialized state', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([collectEnergyCommand(sim.getNextStep(), 2)]);
    sim.tick(10);

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    const restored = createSimRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 50,
      initialSerializedState: savedState,
    });

    const frame = restored.renderCurrentFrame?.();
    expect(frame?.frame.step).toBe(savedState.nextStep - 1);
    expect(frame?.frame.simTimeMs).toBe((savedState.nextStep - 1) * 10);
    expect(hasText(frame, 'Energy: 12 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(frame)).toBe(48);
  });

  it('renders a frame for restored step-0 saves while paused', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    const restored = createSimRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 50,
      initialSerializedState: savedState,
    });

    const frame = restored.renderCurrentFrame?.();
    expect(frame?.frame.step).toBe(0);
    expect(frame?.frame.simTimeMs).toBe(0);
    expect(hasText(frame, 'Energy: 10 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(frame)).toBe(40);
  });

  it('defaults missing scheduler state when loading legacy serialized saves', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });
    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    const {
      accumulatorBacklogMs: _accumulatorBacklogMs,
      offlineCatchupDrainBudgetMs: _offlineCatchupDrainBudgetMs,
      ...legacyState
    } = savedState;

    expect(loadSerializedSimRuntimeState(legacyState)).toEqual({
      ...savedState,
      accumulatorBacklogMs: 0,
      offlineCatchupDrainBudgetMs: 0,
    });
  });

  it('rejects serialized saves with missing or malformed game state data', () => {
    expect(() => loadSerializedSimRuntimeState({
      schemaVersion: 1,
      nextStep: 4,
    })).toThrow(/gameState object/);

    expect(() => loadSerializedSimRuntimeState({
      schemaVersion: 1,
      nextStep: -1,
      gameState: { runtime: { step: 4 } },
    })).toThrow(/nextStep/);

    expect(() => loadSerializedSimRuntimeState({
      schemaVersion: 1,
      nextStep: 4,
      gameState: { runtime: { step: -1 } },
    })).toThrow(/gameState\.runtime\.step/);
  });

  it('rejects malformed scheduler backlog state in serialized saves', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });
    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());

    expect(() => loadSerializedSimRuntimeState({
      ...savedState,
      accumulatorBacklogMs: -1,
    })).toThrow(/accumulatorBacklogMs/);

    expect(() => loadSerializedSimRuntimeState({
      ...savedState,
      accumulatorBacklogMs: 10,
      offlineCatchupDrainBudgetMs: -1,
    })).toThrow(/offlineCatchupDrainBudgetMs/);

    expect(() => loadSerializedSimRuntimeState({
      ...savedState,
      accumulatorBacklogMs: 10,
      offlineCatchupDrainBudgetMs: 20,
    })).toThrow(/offlineCatchupDrainBudgetMs/);
  });

  it('restores pending commands and fractional accumulator backlog from serialized saves', () => {
    const source = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    source.tick(5);
    source.enqueueCommands([collectEnergyCommand(source.getNextStep(), 2)]);

    const savedState = loadSerializedSimRuntimeState(source.serialize?.());
    expect(savedState.accumulatorBacklogMs).toBe(5);
    expect(savedState.offlineCatchupDrainBudgetMs).toBe(0);
    expect(savedState.gameState.commandQueue.entries).toHaveLength(1);

    const expectedNextTick = source.tick(5);
    const expectedStateAfterTick = loadSerializedSimRuntimeState(source.serialize?.());

    const restored = createSimRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 50,
      initialSerializedState: savedState,
    });

    expect(restored.tick(5)).toEqual(expectedNextTick);

    const restoredStateAfterTick = loadSerializedSimRuntimeState(restored.serialize?.());
    expect(restoredStateAfterTick.nextStep).toBe(expectedStateAfterTick.nextStep);
    expect(restoredStateAfterTick.accumulatorBacklogMs).toBe(
      expectedStateAfterTick.accumulatorBacklogMs,
    );
    expect(restoredStateAfterTick.offlineCatchupDrainBudgetMs).toBe(0);
    expect(restoredStateAfterTick.gameState.resources).toEqual(
      expectedStateAfterTick.gameState.resources,
    );
    expect(restoredStateAfterTick.gameState.commandQueue).toEqual(
      expectedStateAfterTick.gameState.commandQueue,
    );
  });

  it('applies offline catch-up payloads without requiring resourceDeltas', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      {
        type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
        priority: CommandPriority.SYSTEM,
        payload: { elapsedMs: 30 },
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(3);
    expect(result.frame?.frame.step).toBe(2);
    expect(result.droppedFrames).toBe(2);
    expect(result.nextStep).toBe(3);
    expect(sim.getNextStep()).toBe(3);
    expect(hasText(result.frames[0], 'Energy: 10 / 100 +0/s')).toBe(true);

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(savedState.nextStep).toBe(3);
  });

  it('does not persist offline catch-up backlog for invalid resourceDeltas shapes', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      {
        type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
        priority: CommandPriority.SYSTEM,
        payload: {
          elapsedMs: 30,
          resourceDeltas: [],
        } as unknown as RuntimeCommandPayloads[typeof RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP],
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);
    expect(result.nextStep).toBe(1);

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(savedState.nextStep).toBe(1);
    expect(savedState.accumulatorBacklogMs).toBe(0);
  });

  it('drains offline catch-up backlog in bounded chunks', () => {
    const drainCreditedBacklog = vi.spyOn(
      IdleEngineRuntime.prototype,
      'drainCreditedBacklog',
    );

    try {
      const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 2 });

      sim.enqueueCommands([
        {
          type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
          priority: CommandPriority.SYSTEM,
          payload: { elapsedMs: 60 },
          timestamp: 0,
          step: sim.getNextStep(),
        },
      ]);

      const result = sim.tick(10);

      expect(result.frames).toHaveLength(4);
      expect(result.frame?.frame.step).toBe(3);
      expect(result.droppedFrames).toBe(3);
      expect(result.nextStep).toBe(4);
      expect(sim.getNextStep()).toBe(4);
      expect(drainCreditedBacklog).toHaveBeenCalledTimes(1);

      const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
      expect(savedState.nextStep).toBe(4);
      expect(savedState.accumulatorBacklogMs).toBe(20);
      expect(savedState.offlineCatchupDrainBudgetMs).toBe(20);

      const continued = sim.tick(0);
      expect(continued.frames).toHaveLength(2);
      expect(continued.frame?.frame.step).toBe(5);
      expect(continued.nextStep).toBe(6);
      expect(drainCreditedBacklog).toHaveBeenCalledTimes(2);
    } finally {
      drainCreditedBacklog.mockRestore();
    }
  });

  it('preserves offline drain budget across multi-step positive frame ticks', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 2 });

    sim.enqueueCommands([
      {
        type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
        priority: CommandPriority.SYSTEM,
        payload: { elapsedMs: 60 },
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    const firstTick = sim.tick(30);
    expect(firstTick.frames).toHaveLength(4);
    expect(firstTick.nextStep).toBe(4);

    const stateAfterFirstTick = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(stateAfterFirstTick.accumulatorBacklogMs).toBe(40);
    expect(stateAfterFirstTick.offlineCatchupDrainBudgetMs).toBe(40);

    const secondTick = sim.tick(0);
    expect(secondTick.frames).toHaveLength(2);
    expect(secondTick.nextStep).toBe(6);

    const stateAfterSecondTick = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(stateAfterSecondTick.accumulatorBacklogMs).toBe(20);
    expect(stateAfterSecondTick.offlineCatchupDrainBudgetMs).toBe(20);

    const thirdTick = sim.tick(0);
    expect(thirdTick.frames).toHaveLength(2);
    expect(thirdTick.nextStep).toBe(8);

    const drainedState = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(drainedState.accumulatorBacklogMs).toBe(0);
    expect(drainedState.offlineCatchupDrainBudgetMs).toBe(0);
  });

  it('restores offline catch-up drain budget for zero-delta backlog drains', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 2 });

    sim.enqueueCommands([
      {
        type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
        priority: CommandPriority.SYSTEM,
        payload: { elapsedMs: 60 },
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    sim.tick(10);

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(savedState.accumulatorBacklogMs).toBe(20);
    expect(savedState.offlineCatchupDrainBudgetMs).toBe(20);

    const restored = createSimRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 2,
      initialSerializedState: savedState,
    });

    const continued = restored.tick(0);
    expect(continued.frames).toHaveLength(2);
    expect(continued.frame?.frame.step).toBe(5);
    expect(continued.nextStep).toBe(6);

    const drainedState = loadSerializedSimRuntimeState(restored.serialize?.());
    expect(drainedState.accumulatorBacklogMs).toBe(0);
    expect(drainedState.offlineCatchupDrainBudgetMs).toBe(0);
  });

  it('does not infer offline drain budget from ordinary restored accumulator backlog', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 2 });

    sim.tick(25);

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(savedState.accumulatorBacklogMs).toBe(5);
    expect(savedState.offlineCatchupDrainBudgetMs).toBe(0);

    const restored = createSimRuntime({
      stepSizeMs: 10,
      maxStepsPerFrame: 2,
      initialSerializedState: savedState,
    });

    const zeroDelta = restored.tick(0);
    expect(zeroDelta.frames).toHaveLength(0);

    const restoredState = loadSerializedSimRuntimeState(restored.serialize?.());
    expect(restoredState.accumulatorBacklogMs).toBe(5);
    expect(restoredState.offlineCatchupDrainBudgetMs).toBe(0);
  });

  it('does not drain a one-hour offline catch-up payload in one tick', () => {
    const sim = createSimRuntime({ stepSizeMs: 16, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      {
        type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
        priority: CommandPriority.SYSTEM,
        payload: { elapsedMs: 60 * 60 * 1000 },
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    const result = sim.tick(16);

    expect(result.frames).toHaveLength(100);
    expect(result.frame?.frame.step).toBe(99);
    expect(result.nextStep).toBe(100);

    const savedState = loadSerializedSimRuntimeState(sim.serialize?.());
    expect(savedState.nextStep).toBe(100);
    expect(savedState.accumulatorBacklogMs).toBeGreaterThan(0);
  });

  it('respects offline catch-up maxElapsedMs and maxSteps limits', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    sim.enqueueCommands([
      {
        type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
        priority: CommandPriority.SYSTEM,
        payload: {
          elapsedMs: 100,
          maxElapsedMs: 40,
          maxSteps: 2,
        },
        timestamp: 0,
        step: sim.getNextStep(),
      },
    ]);

    const result = sim.tick(10);

    expect(result.frames).toHaveLength(2);
    expect(result.frame?.frame.step).toBe(1);
    expect(result.nextStep).toBe(2);
  });

  it('queues sample-pack collection for the next step on in-bounds INPUT_EVENT', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload: pointerPayload(20, 20),
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    const firstTick = sim.tick(10);
    expect(hasText(firstTick.frames[0], 'Energy: 10 / 100 +0/s')).toBe(true);

    const secondTick = sim.tick(10);
    expect(hasText(secondTick.frames[0], 'Energy: 11 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(secondTick.frames[0])).toBe(44);
  });

  it('does not queue sample-pack collection for out-of-bounds INPUT_EVENT', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload: pointerPayload(0, 0),
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    sim.tick(10);
    const secondTick = sim.tick(10);

    expect(hasText(secondTick.frames[0], 'Energy: 10 / 100 +0/s')).toBe(true);
    expect(energyFillWidth(secondTick.frames[0])).toBe(40);
  });

  it('INPUT_EVENT handler throws on schemaVersion mismatch', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const pointerEvent: PointerInputEvent = {
      kind: 'pointer',
      intent: 'mouse-down',
      phase: 'start',
      x: 20,
      y: 20,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    };

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      priority: CommandPriority.PLAYER,
      payload: {
        schemaVersion: 2,
        event: pointerEvent,
      } as unknown as InputEventCommandPayload,
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    expect(() => sim.tick(10)).toThrow('Unsupported InputEventCommandPayload schemaVersion: 2');
  });
});
