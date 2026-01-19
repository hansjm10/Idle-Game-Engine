import { describe, expect, it } from 'vitest';

import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { createSimRuntime } from './sim-runtime.js';
import type { Command } from '@idle-engine/core';

describe('shell-desktop sim runtime', () => {
  it('emits per-step frames with deterministic timing', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const result = sim.tick(35);
    expect(result.frames).toHaveLength(3);
    expect(result.frames[0]?.frame.step).toBe(0);
    expect(result.frames[0]?.frame.simTimeMs).toBe(0);
    expect(result.frames[2]?.frame.step).toBe(2);
    expect(result.frames[2]?.frame.simTimeMs).toBe(20);
    expect(result.nextStep).toBe(3);
    expect(sim.getNextStep()).toBe(3);
    expect(sim.getStepSizeMs()).toBe(10);
  });

  it('executes commands and reflects them in the next frame', () => {
    const sim = createSimRuntime({ stepSizeMs: 10, maxStepsPerFrame: 50 });

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'demo', amount: 1 },
      timestamp: 0,
      step: sim.getNextStep(),
    };

    sim.enqueueCommands([command]);

    const result = sim.tick(10);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0];
    expect(frame?.frame.step).toBe(0);

    const fillRect = frame?.draws.find(
      (draw) =>
        draw.kind === 'rect' &&
        draw.passId === 'ui' &&
        draw.sortKey.sortKeyHi === 0 &&
        draw.sortKey.sortKeyLo === 2,
    );

    expect(fillRect).toMatchObject({
      kind: 'rect',
      passId: 'ui',
      width: 14,
      colorRgba: 0x8a_2a_4f_ff,
    });
  });
});

