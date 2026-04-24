import { describe, expect, it, vi } from 'vitest';

import { sampleContentArtifactHash } from '@idle-engine/content-sample';
import { CommandPriority, IdleEngineRuntime, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { createSimRuntime } from './sim-runtime.js';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE } from '../ipc.js';
import type {
  Command,
  InputEventCommandPayload,
  PointerInputEvent,
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
